import type { GraphOp } from './types.js';

/**
 * The change feed: what happened to a diagram, in the order it happened.
 *
 * This exists because the graph alone answers "what does it look like now" but not
 * "what did you just change", and the latter is the actual message. A human rearranges
 * a diagram and then says "implement that" — the diff *is* the instruction, and an op
 * log records the instruction exactly rather than inferring it from two snapshots.
 * Recording the op means a delete-then-add is distinguishable from a rename, which a
 * structural diff of before/after states can never tell apart.
 */

/**
 * A change to the file that did not come through an op — someone edited the JSON by
 * hand. There is no operation to record, but staying silent would be worse: the rev
 * jumps with no explanation and a reader has no way to know its picture is stale.
 */
export interface ExternalEdit {
  op: 'external_edit';
}

export type LoggedOp = GraphOp | ExternalEdit;

/**
 * `layout` is tagged separately so a consumer that only cares about structure can drop
 * those entries with a single filter. Nudging a box two pixels is rarely part of the
 * message; adding a node always is.
 */
export type ChangeKind = 'structural' | 'layout' | 'external';

/**
 * Who made a change.
 *
 * Inferred from the transport at the server boundary, never taken from the caller — see
 * the note on `withActor`.
 */
export type Actor = 'human' | 'agent';

export interface LogEntry {
  /** The rev this op produced. Entries are strictly ascending. */
  rev: number;
  ts: string;
  kind: ChangeKind;
  /** Which diagram changed. One today; named diagrams make this load-bearing. */
  diagram: string;
  /**
   * Absent on entries written before actors were recorded. Those are unattributable
   * rather than anonymous, and `withActor` deliberately keeps them — see there.
   */
  actor?: Actor;
  op: LoggedOp;
}

/**
 * Drop repositioning from a feed.
 *
 * This is the default for the agent-facing feed, not a nicety. Measured on a real
 * session: 18 of 20 entries were `layout` — the two that carried the actual message
 * ("+ edge testy → test", "− edge test2->test3") were buried under nine times their
 * number in `moved` lines. Multi-select makes it worse, since dragging three selected
 * nodes emits three ops per gesture. A feed that has to be read to be useful cannot be
 * 90% noise.
 *
 * `external` survives the filter: it means the picture is stale, which always matters.
 */
export const withoutLayout = (entries: LogEntry[]): LogEntry[] =>
  entries.filter((entry) => entry.kind !== 'layout');

/** `all` is an explicit request for everything, including the agent's own edits. */
export type ActorFilter = Actor | 'all';

/**
 * Keep only the changes a given actor made.
 *
 * The feed exists to answer "what did the human change", and an agent's own edits are not
 * instructions. Reading them back as if they were is worse than returning nothing: after a
 * context wipe an agent has no memory of what it drew, so its own `generate_graph` looks
 * exactly like a request. That happened — a real feed of 13 entries was 8 agent ops and 5
 * human ones, separable only because the agent still remembered the session.
 *
 * An entry with **no** actor is kept by every filter. Those predate actor recording, so
 * they are unattributable rather than anonymous, and silently dropping them would make an
 * existing log look empty after an upgrade. Showing a change that might not be yours is a
 * smaller error than hiding one that is.
 */
export const withActor = (entries: LogEntry[], actor: ActorFilter): LogEntry[] =>
  actor === 'all' ? entries : entries.filter((e) => e.actor === undefined || e.actor === actor);

/**
 * Ops that only change where things sit.
 *
 * Deliberately NOT `isLayoutOp`. Those two predicates answer different questions and the
 * moment you collapse them into one, something breaks:
 *
 *   - `isLayoutOp` gates the **write surface**: does this op carry a raw coordinate, and
 *     must it therefore stay off the agent's tools? `align` carries none, so the agent may
 *     issue it — that is the whole point of a semantic layout op.
 *   - this gates **feed noise**: is this entry part of the human's message? `align` moves
 *     boxes and nothing else, so it is noise and `withoutLayout` should drop it exactly
 *     like `move_node`.
 *
 * So `align` is issuable by an agent *and* filtered from the feed. Conversely
 * `add_node_at` carries a coordinate — off the agent surface — but brings a node into
 * existence, which is always part of the message, so it stays in the feed.
 *
 * The question here is only ever "did this change what exists, or just where it sits".
 */
const REARRANGING_OPS = new Set(['move_node', 'resize_node', 'align', 'distribute']);

export const kindOf = (op: LoggedOp): ChangeKind =>
  op.op === 'external_edit'
    ? 'external'
    : REARRANGING_OPS.has(op.op)
      ? 'layout'
      : 'structural';

const quote = (s: string) => `"${s}"`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One readable line per op. This is what actually gets read, so it earns its keep. */
export function describeOp(op: LoggedOp): string {
  switch (op.op) {
    case 'add_node':
      return (
        `+ node ${quote(op.label)}` +
        (op.near ? ` near ${op.near}` : '') +
        (op.color && op.color !== 'none' ? ` coloured ${op.color}` : '')
      );
    case 'add_node_at':
      return `+ node ${quote(op.label)} (dropped on canvas)`;
    case 'add_edge':
      return (
        `+ edge ${op.source} → ${op.target}` +
        (op.label ? ` ${quote(op.label)}` : '') +
        (op.color && op.color !== 'none' ? ` coloured ${op.color}` : '')
      );
    case 'reconnect_edge':
      return `~ edge ${op.id} now ${op.source} → ${op.target}`;
    case 'update_node': {
      // One op can carry several changes; naming each is the difference between a reader
      // knowing what happened and having to go and diff the graph itself.
      const parts: string[] = [];
      if (op.label) parts.push(`relabelled ${quote(op.label)}`);
      if (op.color === 'none') parts.push('colour cleared');
      else if (op.color) parts.push(`coloured ${op.color}`);
      if (op.subcanvas === 'none') parts.push('subcanvas unlinked');
      else if (op.subcanvas) parts.push(`subcanvas ${op.subcanvas}`);
      if (op.data) parts.push('data');
      return `~ node ${op.id} ${parts.length ? parts.join(', ') : 'data'}`;
    }
    case 'update_edge': {
      // Same shape as update_node: one op can carry both, so name each part.
      const parts: string[] = [];
      if (op.label !== undefined) parts.push(`labelled ${quote(op.label)}`);
      if (op.color === 'none') parts.push('colour cleared');
      else if (op.color) parts.push(`coloured ${op.color}`);
      return `~ edge ${op.id} ${parts.length ? parts.join(', ') : 'unchanged'}`;
    }
    case 'delete_node':
      return `− node ${op.id}`;
    case 'delete_edge':
      return `− edge ${op.id}`;
    case 'generate_graph': {
      const shape = `generated ${count(op.nodes.length, 'node')}, ${count(op.edges.length, 'edge')}`;
      // A reader must be told the diagram was wiped. Everything they knew about it is
      // gone, and that is not inferable from a node count.
      return op.replace ? `${shape}, replacing what was there` : shape;
    }
    case 'move_node':
      return `moved ${op.id}`;
    // No pixel values, for the same reason `moved` omits coordinates: a summary carries what
    // happened, and the numbers are noise to whoever reads it.
    case 'resize_node':
      return `resized ${op.id}`;
    case 'align': {
      // "left edges" reads better than "left edge" for a group, and centre alignment is an
      // axis rather than an edge at all.
      const on = op.edge.startsWith('center')
        ? `their ${op.edge === 'center-x' ? 'horizontal' : 'vertical'} centres`
        : `their ${op.edge} edges`;
      return `aligned ${count(op.ids.length, 'node')} on ${on}`;
    }
    case 'distribute':
      return `distributed ${count(op.ids.length, 'node')} ${op.axis}ly`;
    case 'external_edit':
      return 'graph file edited outside the server';
  }
}

/**
 * Render entries as a flat chronological list, each tagged with its diagram.
 *
 * Deliberately not grouped by diagram: the order things happened in is often the intent
 * ("I added the retry step, then went in and detailed it"), and grouping destroys it.
 */
export function summarise(entries: LogEntry[]): string {
  if (entries.length === 0) return 'No changes.';
  // Only name the actor when the set actually mixes them. Detected rather than passed in:
  // a caller asking for everything may still get a set that is all one actor, and a column
  // repeating "human" on every line is noise in a feed whose whole point is signal.
  const actors = new Set(entries.map((e) => e.actor ?? 'unknown'));
  const mixed = actors.size > 1;
  return entries
    .map((e) => {
      const who = mixed ? `${(e.actor ?? '?').padEnd(6)}` : '';
      return `${String(e.rev).padStart(4)}  ${who}${e.diagram}  ${describeOp(e.op)}`;
    })
    .join('\n');
}
