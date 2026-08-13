import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  applyOp,
  emptyGraph,
  normalize,
  parse,
  serialize,
  type Graph,
  type GraphOp,
} from '@crosspoint/core';

export interface Change {
  graph: Graph;
  /** Client id that caused the change, if any — lets a sender skip its own echo. */
  origin?: string;
}

type Listener = (change: Change) => void;

export class StaleRevError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Stale write: based on rev ${expected}, current rev is ${actual}`);
  }
}

/**
 * Owns the graph.
 *
 * The server is the single writer; the file is persistence, not the live source of
 * truth. That is what removes the write-echo loop you get when browser and agent both
 * write the file and a watcher fans changes back out. The watcher here exists only to
 * pick up *external* edits (a human editing the JSON in their editor).
 */
export class GraphStore {
  private graph: Graph;
  private listeners = new Set<Listener>();
  private watcher?: FSWatcher;
  /** Last text this process wrote, used to tell our own writes from external ones. */
  private lastWritten = '';
  private persistTimer?: NodeJS.Timeout;

  private constructor(readonly path: string, graph: Graph) {
    this.graph = graph;
  }

  static async open(path: string): Promise<GraphStore> {
    const full = resolve(path);
    let graph: Graph;
    try {
      const text = await readFile(full, 'utf8');
      graph = normalize(parse(text));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      graph = emptyGraph();
      await mkdir(dirname(full), { recursive: true });
    }

    const store = new GraphStore(full, graph);
    await store.persistNow();
    store.startWatching();
    return store;
  }

  current(): Graph {
    return this.graph;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply one op. `baseRev` is optional optimistic concurrency: a caller that read the
   * graph, thought about it, then wrote can be told its view went stale rather than
   * silently overwriting whatever landed in between.
   */
  apply(op: GraphOp, options: { baseRev?: number; origin?: string } = {}): Graph {
    if (options.baseRev !== undefined && options.baseRev !== this.graph.rev) {
      throw new StaleRevError(options.baseRev, this.graph.rev);
    }
    this.graph = applyOp(this.graph, op);
    this.emit(options.origin);
    this.schedulePersist();
    return this.graph;
  }

  async close(): Promise<void> {
    this.watcher?.close();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persistNow();
  }

  private emit(origin?: string): void {
    for (const listener of this.listeners) listener({ graph: this.graph, origin });
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.persistNow();
    }, 80);
  }

  private async persistNow(): Promise<void> {
    const text = serialize(this.graph);
    if (text === this.lastWritten) return;
    this.lastWritten = text;
    // Write-then-rename: a watcher must never observe a half-written file.
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.path);
  }

  /**
   * Pick up edits made to the file outside this process.
   *
   * Watches the *directory*, not the file. Atomic saves replace the file by rename, so a
   * file-level watch is bound to an inode that gets swapped out from under it and goes
   * silent after the first write — including our own. A directory watch survives that.
   */
  private startWatching(): void {
    const name = basename(this.path);
    let debounce: NodeJS.Timeout | undefined;
    try {
      this.watcher = watch(dirname(this.path), (_event, filename) => {
        if (filename && basename(filename) !== name) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void this.reloadFromDisk(), 60);
      });
    } catch {
      // Watching is a convenience; the server is still correct without it.
    }
  }

  private async reloadFromDisk(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return;
    }
    // Our own write coming back through the watcher — not an external edit.
    if (text === this.lastWritten) return;

    try {
      const incoming = normalize(parse(text));
      this.lastWritten = text;
      // The file is behind the in-memory rev by definition once it has been edited by
      // hand; take its content but keep a monotonic rev so clients never move backwards.
      this.graph = { ...incoming, rev: Math.max(incoming.rev, this.graph.rev + 1) };
      this.emit();
    } catch {
      // Mid-edit invalid JSON is expected; the next write will be well-formed.
    }
  }
}
