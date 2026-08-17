import type { Graph } from './types.js';

/**
 * Serialise with a fixed key order and stable array order.
 *
 * Diffability is a real requirement, not a nicety: if key order churns, every write
 * looks like a full-file rewrite to git and to an agent reading the diff, and "the auth
 * node moved" becomes unreadable. Node/edge arrays keep insertion order for the same
 * reason — sorting them would reshuffle the file whenever a label changes.
 */
export function serialize(graph: Graph): string {
  const ordered = {
    rev: graph.rev,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      position: n.position ? { x: n.position.x, y: n.position.y } : undefined,
      // Between position and data, and omitted entirely when unset — an auto-sized node
      // must read as untouched in the file, the way an uncoloured one carries no colour.
      ...(n.size === undefined ? {} : { size: { w: n.size.w, h: n.size.h } }),
      data: orderKeys(n.data),
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.label === undefined ? {} : { label: e.label }),
      ...(e.color === undefined ? {} : { color: e.color }),
    })),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** `label` first, then remaining keys alphabetically, so node data diffs stay stable. */
function orderKeys(data: Record<string, unknown>): Record<string, unknown> {
  const { label, ...rest } = data;
  const out: Record<string, unknown> = { label };
  for (const key of Object.keys(rest).sort()) out[key] = rest[key];
  return out;
}

export function parse(text: string): Graph {
  const raw = JSON.parse(text) as Partial<Graph>;
  return {
    rev: typeof raw.rev === 'number' ? raw.rev : 0,
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
  };
}
