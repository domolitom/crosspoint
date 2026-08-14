import { isLayoutOp, type GraphOp } from './types.js';

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

export interface LogEntry {
  /** The rev this op produced. Entries are strictly ascending. */
  rev: number;
  ts: string;
  kind: ChangeKind;
  /** Which diagram changed. One today; named diagrams make this load-bearing. */
  diagram: string;
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

export const kindOf = (op: LoggedOp): ChangeKind =>
  op.op === 'external_edit' ? 'external' : isLayoutOp(op) ? 'layout' : 'structural';

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
      return `+ edge ${op.source} → ${op.target}${op.label ? ` ${quote(op.label)}` : ''}`;
    case 'reconnect_edge':
      return `~ edge ${op.id} now ${op.source} → ${op.target}`;
    case 'update_node': {
      // One op can carry several changes; naming each is the difference between a reader
      // knowing what happened and having to go and diff the graph itself.
      const parts: string[] = [];
      if (op.label) parts.push(`relabelled ${quote(op.label)}`);
      if (op.color === 'none') parts.push('colour cleared');
      else if (op.color) parts.push(`coloured ${op.color}`);
      if (op.data) parts.push('data');
      return `~ node ${op.id} ${parts.length ? parts.join(', ') : 'data'}`;
    }
    case 'update_edge':
      return `~ edge ${op.id} labelled ${quote(op.label ?? '')}`;
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
  return entries
    .map((e) => `${String(e.rev).padStart(4)}  ${e.diagram}  ${describeOp(e.op)}`)
    .join('\n');
}
