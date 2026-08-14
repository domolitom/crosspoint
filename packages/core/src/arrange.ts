import { GraphError } from './errors.js';
import { estimateNodeHeight, estimateNodeWidth, snapPosition } from './placement.js';
import type { AlignEdge, DistributeAxis, Graph, GraphNode, Position } from './types.js';

/**
 * Resolving layout *intent* into geometry.
 *
 * This is the escape hatch in the coordinates invariant. An agent cannot say `x: 342`, but
 * it can say "line these three up on their left edges" and the server works out what that
 * means. The intent crosses the boundary; the pixels are computed on this side of it.
 *
 * Only the nodes named in `ids` ever move. Everything else stays exactly where the human
 * put it — the same rule placement follows, and the reason a global layout engine is not
 * used here.
 */

interface Box {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxes(graph: Graph, ids: string[], what: string): Box[] {
  if (ids.length < 2) {
    // Aligning one node is meaningless, so it is far more likely to be a mistake than an
    // intention worth silently honouring.
    throw new GraphError(`${what} needs at least two nodes, got ${ids.length}`);
  }

  const seen = new Set<string>();
  return ids.map((id) => {
    if (seen.has(id)) throw new GraphError(`Node "${id}" is listed twice`);
    seen.add(id);

    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new GraphError(`No node with id "${id}"`);
    if (!node.position) throw new GraphError(`Node "${id}" has no position yet`);

    const label = String(node.data?.label ?? node.id);
    return {
      node,
      x: node.position.x,
      y: node.position.y,
      // Real per-node sizes: centring a wide box and a narrow one against one shared
      // constant puts neither where it belongs.
      w: estimateNodeWidth(label),
      h: estimateNodeHeight(label),
    };
  });
}

/** Apply new positions to just the named nodes, leaving every other node untouched. */
function reposition(graph: Graph, moves: Map<string, Position>): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const next = moves.get(node.id);
      return next ? { ...node, position: snapPosition(next) } : node;
    }),
  };
}

export function alignNodes(graph: Graph, ids: string[], edge: AlignEdge): Graph {
  const group = boxes(graph, ids, 'align');
  const moves = new Map<string, Position>();

  switch (edge) {
    case 'left': {
      const target = Math.min(...group.map((b) => b.x));
      for (const b of group) moves.set(b.node.id, { x: target, y: b.y });
      break;
    }
    case 'right': {
      const target = Math.max(...group.map((b) => b.x + b.w));
      for (const b of group) moves.set(b.node.id, { x: target - b.w, y: b.y });
      break;
    }
    case 'top': {
      const target = Math.min(...group.map((b) => b.y));
      for (const b of group) moves.set(b.node.id, { x: b.x, y: target });
      break;
    }
    case 'bottom': {
      const target = Math.max(...group.map((b) => b.y + b.h));
      for (const b of group) moves.set(b.node.id, { x: b.x, y: target - b.h });
      break;
    }
    case 'center-x': {
      // Centre of the group's bounding box, which is stable — averaging the centres would
      // drift towards wherever the boxes happen to be clustered.
      const left = Math.min(...group.map((b) => b.x));
      const right = Math.max(...group.map((b) => b.x + b.w));
      const centre = (left + right) / 2;
      for (const b of group) moves.set(b.node.id, { x: centre - b.w / 2, y: b.y });
      break;
    }
    case 'center-y': {
      const top = Math.min(...group.map((b) => b.y));
      const bottom = Math.max(...group.map((b) => b.y + b.h));
      const centre = (top + bottom) / 2;
      for (const b of group) moves.set(b.node.id, { x: b.x, y: centre - b.h / 2 });
      break;
    }
  }

  return reposition(graph, moves);
}

/**
 * Even *gaps*, not even centres.
 *
 * With mixed box sizes those differ, and equal gaps is what "space these out" means to a
 * human looking at it. The outermost two nodes stay put and define the span.
 */
export function distributeNodes(graph: Graph, ids: string[], axis: DistributeAxis): Graph {
  const group = boxes(graph, ids, 'distribute');
  const horizontal = axis === 'horizontal';

  const sorted = [...group].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const start = horizontal ? sorted[0].x : sorted[0].y;
  const last = sorted[sorted.length - 1];
  const end = horizontal ? last.x + last.w : last.y + last.h;
  const occupied = sorted.reduce((sum, b) => sum + (horizontal ? b.w : b.h), 0);
  const gap = (end - start - occupied) / (sorted.length - 1);

  // The outermost nodes are anchors, so the span is fixed. If the boxes need more room
  // than that span, no arrangement satisfies the request: the only options are overlapping
  // them or moving an anchor. Refusing beats doing nothing while reporting success — the
  // caller asked for a tidy and would otherwise be told it happened.
  if (gap < 0) {
    const axisName = horizontal ? 'wide' : 'tall';
    throw new GraphError(
      `Cannot distribute ${sorted.length} nodes ${axis}ly: they are ${Math.round(occupied)}px ` +
        `${axisName} in total but only ${Math.round(end - start)}px apart. Move the outermost ` +
        'nodes further apart first, or distribute fewer of them.',
    );
  }

  const moves = new Map<string, Position>();
  let cursor = start;
  for (const b of sorted) {
    moves.set(b.node.id, horizontal ? { x: cursor, y: b.y } : { x: b.x, y: cursor });
    cursor += (horizontal ? b.w : b.h) + gap;
  }

  return reposition(graph, moves);
}
