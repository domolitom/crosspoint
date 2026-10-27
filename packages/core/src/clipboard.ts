import type { Graph, GraphOp, PastedEdge, PastedNode } from './types.js';

export interface Clip {
  nodes: PastedNode[];
  edges: PastedEdge[];
}

/** Copy the given nodes and every edge with both ends among them. `null` if none exist. */
export function copySelection(graph: Graph, ids: Iterable<string>): Clip | null {
  const wanted = new Set(ids);
  const nodes: PastedNode[] = graph.nodes
    .filter((n) => wanted.has(n.id))
    .map((n) => ({
      ref: n.id,
      position: { ...(n.position ?? { x: 0, y: 0 }) },
      ...(n.size ? { size: { ...n.size } } : {}),
      data: structuredClone(n.data),
    }));
  if (nodes.length === 0) return null;
  const kept = new Set(nodes.map((n) => n.ref));
  const edges: PastedEdge[] = graph.edges
    .filter((e) => kept.has(e.source) && kept.has(e.target))
    .map(({ source, target, label, color, arrow, sourceSide, targetSide }) => ({
      source,
      target,
      ...(label !== undefined ? { label } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(arrow !== undefined ? { arrow } : {}),
      ...(sourceSide !== undefined ? { sourceSide } : {}),
      ...(targetSide !== undefined ? { targetSide } : {}),
    }));
  return { nodes, edges };
}

/** The `paste` op for a clip, every node shifted by the same offset. */
export const pasteOp = (clip: Clip, dx: number, dy: number): GraphOp => ({
  op: 'paste',
  nodes: clip.nodes.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } })),
  edges: clip.edges,
});
