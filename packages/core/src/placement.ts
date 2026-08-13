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

/**
 * Node metrics, mirrored from the canvas CSS.
 *
 * Nodes size themselves to their label in the browser, but placement runs on the server,
 * which has no DOM and cannot measure rendered text. So it estimates. The estimate is
 * deliberately a little generous: erring wide costs some whitespace, erring narrow puts
 * two boxes on top of each other.
 */
export const MIN_NODE_WIDTH = 120;
export const MAX_NODE_WIDTH = 320;
/** Height of a single-line node. */
export const NODE_HEIGHT = 60;

/** Rough advance per character at the canvas's 13px font. */
const CHAR_ADVANCE = 7;
/** Horizontal padding and borders, subtracted to get the usable text width. */
const PADDING_X = 26;
const LINE_HEIGHT = 18;
const GAP = 30;

const snap = (n: number) => Math.round(n / GRID) * GRID;
const clamp = (n: number) => Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, n));

/** What `width: fit-content` clamped to [MIN, MAX] would produce for this label. */
export function estimateNodeWidth(label: string): number {
  return clamp(Math.ceil((label?.length ?? 0) * CHAR_ADVANCE) + PADDING_X);
}

/** Taller when the label wraps, which it does once the width hits the max. */
export function estimateNodeHeight(label: string): number {
  const usable = estimateNodeWidth(label) - PADDING_X;
  const lines = Math.max(1, Math.ceil(((label?.length ?? 0) * CHAR_ADVANCE) / usable));
  return NODE_HEIGHT + (lines - 1) * LINE_HEIGHT;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const boxFor = (position: Position, label: string): Box => ({
  x: position.x,
  y: position.y,
  w: estimateNodeWidth(label),
  h: estimateNodeHeight(label),
});

/**
 * Positions are top-left corners, so this compares real rectangles rather than centre
 * distances against one shared constant — which is what broke once widths varied.
 */
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w + GAP &&
  b.x < a.x + a.w + GAP &&
  a.y < b.y + b.h + GAP &&
  b.y < a.y + a.h + GAP;

export interface PlacementHint {
  /** Place near this node if it exists and is already positioned. */
  near?: string;
  /** Label of the node being placed, so its own width is accounted for. */
  label?: string;
}

/**
 * Pick a free position for a new node.
 *
 * Anchors below the `near` node when given, otherwise to the right of the rightmost
 * existing node, otherwise the origin. Then walks down-and-right until it finds a spot
 * that collides with nothing.
 */
export function placeNode(nodes: GraphNode[], hint: PlacementHint = {}): Position {
  // Each existing node contributes its own estimated footprint, not a shared constant.
  const placed: Box[] = nodes
    .filter((n) => n.position != null)
    .map((n) => boxFor(n.position!, String(n.data?.label ?? n.id)));

  const own = { w: estimateNodeWidth(hint.label ?? ''), h: estimateNodeHeight(hint.label ?? '') };
  const anchor = resolveAnchor(placed, nodes, hint, own);

  // Walk a simple lattice out from the anchor until nothing overlaps.
  for (let ring = 0; ring < 100; ring++) {
    for (let col = 0; col <= ring; col++) {
      const candidate: Box = {
        x: snap(anchor.x + col * (own.w + GAP)),
        y: snap(anchor.y + (ring - col) * (own.h + GAP)),
        ...own,
      };
      if (!placed.some((box) => overlaps(candidate, box))) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }

  // Pathological fallback: far enough out that it cannot collide.
  return { x: snap(anchor.x), y: snap(anchor.y + 100 * (own.h + GAP)) };
}

function resolveAnchor(
  placed: Box[],
  nodes: GraphNode[],
  hint: PlacementHint,
  own: { w: number; h: number },
): Position {
  if (hint.near) {
    const target = nodes.find((n) => n.id === hint.near);
    if (target?.position) {
      // Below the anchor node — reads as "downstream of" in most diagrams.
      const height = estimateNodeHeight(String(target.data?.label ?? target.id));
      return { x: target.position.x, y: target.position.y + height + GAP };
    }
  }
  if (placed.length === 0) return { x: 0, y: 0 };

  // Clear the rightmost node's own right edge, which now varies with its label.
  const rightmost = placed.reduce((a, b) => (b.x + b.w > a.x + a.w ? b : a));
  return { x: rightmost.x + rightmost.w + GAP, y: rightmost.y };
}

/** Snap a human-supplied position to the grid, keeping drags and agent seeds aligned. */
export const snapPosition = (p: Position): Position => ({ x: snap(p.x), y: snap(p.y) });
