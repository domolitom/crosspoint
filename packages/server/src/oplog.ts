import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';

import { kindOf, type Actor, type LogEntry, type LoggedOp } from '@crosspoint/core';

/**
 * Append-only history of everything that happened across the whole workspace.
 *
 * One log, not one per diagram: the feed an agent reads is a single chronological list
 * spanning every diagram, and merging several independently-numbered logs into a total
 * order is not possible. Each entry carries the diagram it belongs to instead.
 *
 * Entries live in memory and are flushed to a `.ops.jsonl` sidecar. Reads are served
 * from memory, so a lagging disk write can never produce a wrong answer — the same
 * split the graph itself uses, where the file is persistence rather than the live
 * source of truth.
 *
 * Retention is unbounded. A long-lived workspace will grow this file forever; rotation is
 * deliberately not built yet, because trimming history silently is worse than a large
 * file and there is no evidence yet about what a useful window would be.
 */
export class OpLog {
  private entries: LogEntry[] = [];
  /** How many entries are already on disk; the rest are pending append. */
  private flushed = 0;
  private writing: Promise<void> = Promise.resolve();
  private watermarkValue = 0;
  /** Which diagram the canvas should show, and every diagram we have seen. */
  private activeValue?: string;
  private knownValue: string[] = [];
  /** Makes each state temp path unique, so concurrent writers cannot clobber one another. */
  private stateSeq = 0;

  private constructor(
    readonly path: string,
    readonly statePath: string,
  ) {}

  static async open(sidecarBase: string): Promise<OpLog> {
    const base = sidecarBase.replace(/\.json$/, '');
    const log = new OpLog(`${base}.ops.jsonl`, `${base}.state.json`);

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

    /*
     * A damaged state file must not stop the server.
     *
     * Everything in here is recoverable — the log holds the diagram names and the files hold
     * the graphs — so refusing to boot costs the human their whole workspace to save a
     * watermark. An empty file is the case that actually happened: a non-atomic write killed
     * mid-flight left zero bytes, and `JSON.parse('')` threw on every subsequent start. One
     * mechanism covers it, deliberately — a separate empty-string branch reads as a second
     * line of defence and is not: tolerating `SyntaxError` already answers both, so removing
     * the branch alone failed no test and proved nothing.
     */
    try {
      const state = JSON.parse(await readFile(log.statePath, 'utf8')) as {
        watermark?: number;
        active?: string;
        known?: string[];
      };
      log.watermarkValue = state.watermark ?? 0;
      log.activeValue = state.active;
      log.knownValue = Array.isArray(state.known) ? state.known : [];
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }

    return log;
  }

  get watermark(): number {
    return this.watermarkValue;
  }

  /** The active diagram as of the last run, if any. */
  get active(): string | undefined {
    return this.activeValue;
  }

  /**
   * Diagrams recorded in state.
   *
   * This is what lets single-file mode have more than one diagram without scanning the
   * directory — which would otherwise adopt `package.json` and friends as diagrams.
   */
  get knownDiagrams(): string[] {
    return this.knownValue;
  }

  /**
   * Every diagram the log has an entry for.
   *
   * The recovery path for a lost `known`: the log is append-only, so it remembers names the
   * state file no longer does.
   */
  get diagramsInLog(): string[] {
    return [...new Set(this.entries.map((e) => e.diagram).filter(Boolean))];
  }

  get latestRev(): number {
    return this.entries.at(-1)?.rev ?? 0;
  }

  /** Record an op that has already been applied and validated. */
  record(rev: number, op: LoggedOp, diagram: string, actor: Actor): LogEntry {
    const entry: LogEntry = {
      rev,
      ts: new Date().toISOString(),
      kind: kindOf(op),
      diagram,
      actor,
      op,
    };
    this.entries.push(entry);
    this.scheduleFlush();
    return entry;
  }

  /**
   * Record something no transport can attribute.
   *
   * Separate from `record` so that one keeps its required `actor` — the guard that makes a
   * new transport a compile error rather than a silent misattribution. Creating a diagram
   * is the case: the canvas and the MCP server both reach it over HTTP, so "who" genuinely
   * is not knowable here, and an entry with no actor is kept by every filter. Claiming
   * `agent` would hide every diagram a human made from the default feed.
   */
  recordUnattributed(rev: number, op: LoggedOp, diagram: string): LogEntry {
    const entry: LogEntry = { rev, ts: new Date().toISOString(), kind: kindOf(op), diagram, op };
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

  /** Record workspace state the graph files cannot carry: which diagram is active. */
  async saveState(state: { active: string; known: string[] }): Promise<void> {
    this.activeValue = state.active;
    this.knownValue = state.known;
    await this.persistState();
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
    const state = {
      watermark: this.watermarkValue,
      active: this.activeValue,
      known: this.knownValue,
    };
    // Write-then-rename, exactly like a diagram. A plain write truncates first, so a process
    // killed in that window leaves a zero-byte file — and in file mode this sidecar *is* the
    // diagram list, so losing it hides every diagram the directory still holds.
    const tmp = `${this.statePath}.${process.pid}.${this.stateSeq++}.tmp`;
    await writeFile(tmp, JSON.stringify(state) + '\n', 'utf8');
    await rename(tmp, this.statePath);
  }
}
