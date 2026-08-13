import { appendFile, readFile, writeFile } from 'node:fs/promises';

import { kindOf, type LogEntry, type LoggedOp } from '@crosspoint/core';

/**
 * Append-only history of everything that happened to a diagram.
 *
 * Entries live in memory and are flushed to a `.ops.jsonl` sidecar. Reads are served
 * from memory, so a lagging disk write can never produce a wrong answer — the same
 * split the graph itself uses, where the file is persistence rather than the live
 * source of truth.
 *
 * Retention is unbounded. A long-lived diagram will grow this file forever; rotation is
 * deliberately not built yet, because trimming history silently is worse than a large
 * file and there is no evidence yet about what a useful window would be.
 */
export class OpLog {
  private entries: LogEntry[] = [];
  /** How many entries are already on disk; the rest are pending append. */
  private flushed = 0;
  private writing: Promise<void> = Promise.resolve();
  private watermarkValue = 0;

  private constructor(
    readonly path: string,
    readonly statePath: string,
    readonly diagram: string,
  ) {}

  static async open(graphPath: string): Promise<OpLog> {
    const base = graphPath.replace(/\.json$/, '');
    const diagram = base.split('/').pop() || 'graph';
    const log = new OpLog(`${base}.ops.jsonl`, `${base}.state.json`, diagram);

    // A missing log is an empty history, not an error. An existing graph with no log
    // simply has no recorded past — do not invent one.
    try {
      const text = await readFile(log.path, 'utf8');
      log.entries = text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as LogEntry);
      log.flushed = log.entries.length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    try {
      const state = JSON.parse(await readFile(log.statePath, 'utf8')) as { watermark?: number };
      log.watermarkValue = state.watermark ?? 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    return log;
  }

  get watermark(): number {
    return this.watermarkValue;
  }

  get latestRev(): number {
    return this.entries.at(-1)?.rev ?? 0;
  }

  /** Record an op that has already been applied and validated. */
  record(rev: number, op: LoggedOp): LogEntry {
    const entry: LogEntry = {
      rev,
      ts: new Date().toISOString(),
      kind: kindOf(op),
      diagram: this.diagram,
      op,
    };
    this.entries.push(entry);
    this.scheduleFlush();
    return entry;
  }

  /** Everything after `rev`. Does not touch the watermark — repeatable by design. */
  since(rev: number): LogEntry[] {
    return this.entries.filter((e) => e.rev > rev);
  }

  /**
   * Everything the caller has not seen, advancing the watermark past it.
   *
   * The watermark is what makes "what changed since we last spoke" answerable at all:
   * an agent's memory of a rev number does not survive a new session or a compacted
   * context, so the server has to remember on its behalf.
   */
  consume(): LogEntry[] {
    const entries = this.since(this.watermarkValue);
    if (entries.length > 0) {
      this.watermarkValue = entries.at(-1)!.rev;
      void this.persistState();
    }
    return entries;
  }

  async close(): Promise<void> {
    this.scheduleFlush();
    await this.writing;
    await this.persistState();
  }

  /** Serialised through a promise chain so appends can never interleave or reorder. */
  private scheduleFlush(): void {
    this.writing = this.writing.then(() => this.flushNow()).catch(() => {});
  }

  private async flushNow(): Promise<void> {
    const pending = this.entries.slice(this.flushed);
    if (pending.length === 0) return;
    await appendFile(this.path, pending.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    this.flushed += pending.length;
  }

  private async persistState(): Promise<void> {
    await writeFile(this.statePath, JSON.stringify({ watermark: this.watermarkValue }) + '\n');
  }
}
