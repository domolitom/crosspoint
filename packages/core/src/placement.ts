import type { GraphNode, Position } from './types.js';

/**
 * Seed placement for nodes that arrive without coordinates.
 *
 * Deliberately *not* a global layout engine. Running dagre/elk would re-solve the whole
 * diagram and move nodes the human has already pinned, which is the exact failure mode
 * stored positions exist to prevent. This only ever picks a spot for the new node and
 * leaves every existing node untouched.
 */

export const GRID = 15;

/** Assumed node footprint for collision checks; matches the canvas node CSS. */
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 60;
const GAP = 30;

const snap = (n: number) => Math.round(n / GRID) * GRID;

const overlaps = (a: Position, b: Position) =>
  Math.abs(a.x - b.x) < NODE_WIDTH + GAP && Math.abs(a.y - b.y) < NODE_HEIGHT + GAP;

export interface PlacementHint {
  /** Place near this node if it exists and is already positioned. */
  near?: string;
}

/**
 * Pick a free position for a new node.
 *
 * Anchors below the `near` node when given, otherwise to the right of the rightmost
 * existing node, otherwise the origin. Then walks down-and-right until it finds a spot
 * that collides with nothing.
 */
export function placeNode(nodes: GraphNode[], hint: PlacementHint = {}): Position {
  const placed = nodes
    .map((n) => n.position)
    .filter((p): p is Position => p != null);

  const anchor = resolveAnchor(placed, nodes, hint);

  // Walk a simple lattice out from the anchor until nothing overlaps.
  for (let ring = 0; ring < 100; ring++) {
    for (let col = 0; col <= ring; col++) {
      const candidate = {
        x: snap(anchor.x + col * (NODE_WIDTH + GAP)),
        y: snap(anchor.y + (ring - col) * (NODE_HEIGHT + GAP)),
      };
      if (!placed.some((p) => overlaps(candidate, p))) return candidate;
    }
  }

  // Pathological fallback: far enough out that it cannot collide.
  return { x: snap(anchor.x), y: snap(anchor.y + 100 * (NODE_HEIGHT + GAP)) };
}

function resolveAnchor(
  placed: Position[],
  nodes: GraphNode[],
  hint: PlacementHint,
): Position {
  if (hint.near) {
    const target = nodes.find((n) => n.id === hint.near);
    if (target?.position) {
      // Below the anchor node — reads as "downstream of" in most diagrams.
      return { x: target.position.x, y: target.position.y + NODE_HEIGHT + GAP };
    }
  }
  if (placed.length === 0) return { x: 0, y: 0 };

  const rightmost = placed.reduce((a, b) => (b.x > a.x ? b : a));
  return { x: rightmost.x + NODE_WIDTH + GAP, y: rightmost.y };
}

/** Snap a human-supplied position to the grid, keeping drags and agent seeds aligned. */
export const snapPosition = (p: Position): Position => ({ x: snap(p.x), y: snap(p.y) });
