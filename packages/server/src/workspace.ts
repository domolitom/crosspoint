import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { applyOp, type Actor, type Graph, type GraphOp, type LogEntry } from '@crosspoint/core';

import { DiagramFile, StaleRevError } from './diagram.js';
import { OpLog } from './oplog.js';

export { StaleRevError };

export type WorkspaceEvent =
  | {
      type: 'graph';
      diagram: string;
      graph: Graph;
      /** Client id that caused the change, if any — lets a sender skip its own echo. */
      origin?: string;
    }
  | { type: 'diagrams' };

type Listener = (event: WorkspaceEvent) => void;

export class UnknownDiagramError extends Error {
  constructor(name: string, known: string[]) {
    super(`No diagram named "${name}". Known: ${known.join(', ') || '(none)'}`);
  }
}

export class DiagramExistsError extends Error {
  constructor(name: string) {
    super(`A diagram named "${name}" already exists`);
  }
}

/**
 * Diagram names double as filenames, so anything that could escape the workspace
 * directory or collide with a sidecar is refused rather than sanitised — quietly
 * rewriting a name would leave the caller referring to a diagram that does not exist.
 */
export function validateName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `Invalid diagram name "${name}". Use letters, digits, dot, dash or underscore, ` +
        'starting with a letter or digit.',
    );
  }
  if (name.includes('..') || /\.(state|ops)$/.test(name)) {
    throw new Error(`Invalid diagram name "${name}".`);
  }
  return name;
}

/** Sidecars are `.json` too, so discovery has to skip them explicitly. */
const isSidecar = (file: string) =>
  file.endsWith('.state.json') || file.endsWith('.ops.jsonl') || file.includes('.tmp');

/**
 * Owns every diagram in a directory, and the single history that spans them.
 *
 * `rev` is one monotonic counter for the whole workspace, not per diagram. That is what
 * makes `get_changes` answerable: a flat chronological feed across diagrams needs a total
 * order, and two diagrams that both reached "rev 5" have none. A diagram file's stored
 * `rev` therefore reads as "the workspace rev at which this file was last written", which
 * is still exactly what an optimistic-concurrency check needs.
 *
 * The server remains the single writer; files are persistence. The watcher exists only to
 * pick up *external* edits.
 */
export class Workspace {
  private diagrams = new Map<string, DiagramFile>();
  private listeners = new Set<Listener>();
  private watcher?: FSWatcher;
  private revValue = 0;
  private activeName = '';

  private constructor(
    readonly dir: string,
    readonly log: OpLog,
    /** `file` means we were pointed at a single graph file rather than a directory. */
    readonly mode: 'dir' | 'file',
  ) {}

  static async open(target: string): Promise<Workspace> {
    const full = resolve(target);
    const looksLikeFile = full.endsWith('.json');

    let mode: 'dir' | 'file' = 'dir';
    let dir = full;
    let seed: string | undefined;
    /** True when we are about to create the directory rather than adopt an existing one. */
    let fresh = false;

    try {
      const info = await stat(full);
      if (info.isDirectory()) {
        mode = 'dir';
        dir = full;
      } else {
        mode = 'file';
        dir = dirname(full);
        seed = basename(full).replace(/\.json$/, '');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Nothing there yet: a `.json` path means single-file mode, anything else a directory.
      if (looksLikeFile) {
        mode = 'file';
        dir = dirname(full);
        seed = basename(full).replace(/\.json$/, '');
      } else {
        fresh = true;
      }
    }

    await mkdir(dir, { recursive: true });

    /*
     * A workspace we created ignores itself.
     *
     * Diagrams live inside the project being worked on, and that project's `.gitignore` is
     * not ours to edit. A `*` here keeps the folder out of its git without touching anything
     * we do not own. Only for a directory we just made: pointed at somewhere that already
     * exists, silently ignoring its contents would be presumptuous.
     */
    if (fresh && mode === 'dir') {
      const ignore = join(dir, '.gitignore');
      try {
        await stat(ignore);
      } catch {
        await writeFile(ignore, '*\n', 'utf8');
      }
    }

    // In file mode the sidecars keep the old `<base>.ops.jsonl` naming so an existing
    // history carries over rather than being orphaned by this change.
    const sidecarBase = mode === 'file' ? full.replace(/\.json$/, '') : join(dir, '.crosspoint');
    const log = await OpLog.open(sidecarBase);
    const workspace = new Workspace(dir, log, mode);

    const names = new Set<string>(log.knownDiagrams);
    if (seed) names.add(seed);
    if (mode === 'dir') {
      for (const file of await readdir(dir)) {
        if (file.endsWith('.json') && !isSidecar(file)) names.add(file.replace(/\.json$/, ''));
      }
    }
    if (names.size === 0) names.add('graph');

    for (const name of [...names].sort()) {
      try {
        validateName(name);
      } catch {
        continue; // A stray file with an unusable name is not a diagram.
      }
      workspace.diagrams.set(name, await DiagramFile.open(name, join(dir, `${name}.json`)));
    }

    // Never go backwards after a restart: the highest rev any file or the log has seen.
    workspace.revValue = Math.max(
      log.latestRev,
      ...[...workspace.diagrams.values()].map((d) => d.current().rev),
    );

    workspace.activeName = workspace.resolveActive(log.active);
    await workspace.saveState();

    // Create any file that does not exist yet, so the directory reflects what we serve.
    for (const diagram of workspace.diagrams.values()) await diagram.persistNow();

    workspace.startWatching();
    return workspace;
  }

  private resolveActive(preferred?: string): string {
    if (preferred && this.diagrams.has(preferred)) return preferred;
    if (this.diagrams.has('graph')) return 'graph';
    return [...this.diagrams.keys()].sort()[0];
  }

  get rev(): number {
    return this.revValue;
  }

  get active(): string {
    return this.activeName;
  }

  names(): string[] {
    return [...this.diagrams.keys()].sort();
  }

  list(): Array<{ name: string; nodes: number; edges: number; rev: number }> {
    return this.names().map((name) => {
      const graph = this.diagrams.get(name)!.current();
      return { name, nodes: graph.nodes.length, edges: graph.edges.length, rev: graph.rev };
    });
  }

  /** The active diagram's graph — what every existing graph endpoint operates on. */
  current(): Graph {
    return this.file(this.activeName).current();
  }

  /**
   * Any diagram's graph by name, defaulting to the active one.
   *
   * A lens panel renders a diagram the human is not "in", so reading one must not require
   * switching to it — switching would move the main canvas out from under them.
   */
  graphOf(name?: string): Graph {
    return this.file(name ?? this.activeName).current();
  }

  has(name: string): boolean {
    return this.diagrams.has(name);
  }

  private file(name: string): DiagramFile {
    const diagram = this.diagrams.get(name);
    if (!diagram) throw new UnknownDiagramError(name, this.names());
    return diagram;
  }

  private nextRev(): number {
    return ++this.revValue;
  }

  /**
   * Apply one op to a diagram, defaulting to the active one.
   *
   * `baseRev` is optional optimistic concurrency: a caller that read the graph, thought
   * about it, then wrote can be told its view went stale rather than silently overwriting
   * whatever landed in between.
   */
  apply(
    op: GraphOp,
    options: { actor: Actor; baseRev?: number; origin?: string; diagram?: string },
  ): Graph {
    const file = this.file(options.diagram ?? this.activeName);
    const graph = file.current();
    if (options.baseRev !== undefined && options.baseRev !== graph.rev) {
      throw new StaleRevError(options.baseRev, graph.rev);
    }
    // applyOp throws on an invalid op, so nothing below runs for a rejected one — the log
    // only ever contains changes that actually happened. The rev it computes is discarded
    // in favour of the workspace counter.
    const next = { ...applyOp(graph, op), rev: this.nextRev() };
    file.replace(next);
    this.log.record(next.rev, op, file.name, options.actor);
    this.emit({ type: 'graph', diagram: file.name, graph: next, origin: options.origin });
    return next;
  }

  async create(name: string): Promise<void> {
    validateName(name);
    if (this.diagrams.has(name)) throw new DiagramExistsError(name);
    const diagram = new DiagramFile(name, join(this.dir, `${name}.json`), {
      rev: this.revValue,
      nodes: [],
      edges: [],
    });
    await diagram.persistNow();
    this.diagrams.set(name, diagram);
    await this.saveState();
    // Creating does not switch: the human is still looking at whatever they were.
    this.emit({ type: 'diagrams' });
  }

  switchTo(name: string): void {
    const diagram = this.file(name);
    if (this.activeName === name) return;
    this.activeName = name;
    void this.saveState();
    this.emit({ type: 'diagrams' });
    // Push the new content so every connected canvas follows.
    this.emit({ type: 'graph', diagram: name, graph: diagram.current() });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Everything after `rev` across every diagram, leaving the watermark alone. */
  changesSince(rev: number): LogEntry[] {
    return this.log.since(rev);
  }

  /** Everything unseen across every diagram, advancing the watermark past it. */
  consumeChanges(): LogEntry[] {
    return this.log.consume();
  }

  async close(): Promise<void> {
    this.watcher?.close();
    for (const diagram of this.diagrams.values()) await diagram.close();
    await this.log.close();
  }

  private emit(event: WorkspaceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async saveState(): Promise<void> {
    await this.log.saveState({ active: this.activeName, known: this.names() });
  }

  /**
   * Pick up edits made to files outside this process.
   *
   * Watches the *directory*, not each file. Atomic saves replace a file by rename, so a
   * file-level watch is bound to an inode that gets swapped out from under it and goes
   * silent after the first write — including the server's own.
   */
  private startWatching(): void {
    const pending = new Map<string, NodeJS.Timeout>();
    try {
      this.watcher = watch(this.dir, (_event, filename) => {
        if (!filename) return;
        const file = basename(filename);
        if (!file.endsWith('.json') || isSidecar(file)) return;
        const name = file.replace(/\.json$/, '');
        // Only adopt unheard-of files in directory mode; in file mode the directory is
        // somewhere like the repo root, full of `.json` that are not diagrams.
        if (!this.diagrams.has(name) && this.mode !== 'dir') return;

        clearTimeout(pending.get(name));
        pending.set(
          name,
          setTimeout(() => {
            pending.delete(name);
            void this.reload(name);
          }, 60),
        );
      });
    } catch {
      // Watching is a convenience; the server is still correct without it.
    }
  }

  private async reload(name: string): Promise<void> {
    let diagram = this.diagrams.get(name);
    if (!diagram) {
      try {
        validateName(name);
      } catch {
        return;
      }
      diagram = await DiagramFile.open(name, join(this.dir, `${name}.json`));
      this.diagrams.set(name, diagram);
      await this.saveState();
      this.emit({ type: 'diagrams' });
    }

    const incoming = await diagram.reload();
    if (!incoming) return;

    // A hand edit produces no op, but silence would be worse than an imprecise entry: the
    // rev jumps and a reader has no way to know its picture went stale. Record that
    // something happened outside the op stream and let the reader re-read.
    const next = { ...incoming, rev: this.nextRev() };
    diagram.adopt(next);
    // A hand edit to the file is a person acting outside the app, not the agent.
    this.log.record(next.rev, { op: 'external_edit' }, name, 'human');
    this.emit({ type: 'graph', diagram: name, graph: next });
  }
}
