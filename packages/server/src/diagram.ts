import { readFile, rename, writeFile } from 'node:fs/promises';

import { normalize, parse, serialize, type Graph } from '@crosspoint/core';

export class StaleRevError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Stale write: based on rev ${expected}, current rev is ${actual}`);
  }
}

/**
 * One diagram file on disk.
 *
 * Deliberately dumb: it holds a graph, writes it atomically, and can tell its own writes
 * from someone else's. It knows nothing about revs — those are allocated by the workspace,
 * because a single monotonic counter across every diagram is what makes one chronological
 * change feed possible at all.
 */
export class DiagramFile {
  private graph: Graph;
  /** Last text this process wrote, used to tell our own writes from external ones. */
  private lastWritten = '';
  private persistTimer?: NodeJS.Timeout;

  constructor(
    readonly name: string,
    readonly path: string,
    graph: Graph,
  ) {
    this.graph = graph;
  }

  static async open(name: string, path: string): Promise<DiagramFile> {
    let graph: Graph;
    try {
      graph = normalize(parse(await readFile(path, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      graph = { rev: 0, nodes: [], edges: [] };
    }
    return new DiagramFile(name, path, graph);
  }

  current(): Graph {
    return this.graph;
  }

  /** Replace the graph and schedule a write. The caller has already allocated the rev. */
  replace(graph: Graph): void {
    this.graph = graph;
    this.schedulePersist();
  }

  /**
   * Take a graph that came *from* the file, without scheduling a write back.
   *
   * A hand edit must not be immediately rewritten in our own normalised form — that would
   * reformat the file under the editor that is still open on it.
   */
  adopt(graph: Graph): void {
    this.graph = graph;
  }

  /**
   * Re-read the file because something outside this process touched it.
   *
   * Returns the parsed graph, or null when there is nothing to do — either the change was
   * our own write echoing back through the watcher, or the file is mid-edit and invalid.
   */
  async reload(): Promise<Graph | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return null;
    }
    if (text === this.lastWritten) return null;

    try {
      const incoming = normalize(parse(text));
      this.lastWritten = text;
      return incoming;
    } catch {
      // Mid-edit invalid JSON is expected; the next write will be well-formed.
      return null;
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.persistNow();
    }, 80);
  }

  async persistNow(): Promise<void> {
    const text = serialize(this.graph);
    if (text === this.lastWritten) return;
    this.lastWritten = text;
    // Write-then-rename: a watcher must never observe a half-written file.
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.path);
  }

  async close(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persistNow();
  }
}
