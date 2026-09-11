import type { EdgeSide, GraphNode, Position, Size } from './types.js';

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

/**
 * What `width: fit-content` clamped to [MIN, MAX] would produce for this text.
 *
 * Measured on the *longest line*, not the total length: text with explicit breaks is as wide
 * as its widest line, and summing it would ask for a box several times too wide. The server
 * has no DOM, so this estimate is all placement has — and a wrong one puts nodes on top of
 * each other, which is a bug this repo has already paid for once.
 */
export function estimateNodeWidth(text: string): number {
  const longest = Math.max(0, ...String(text ?? '').split('\n').map((line) => line.length));
  return clamp(Math.ceil(longest * CHAR_ADVANCE) + PADDING_X);
}

/**
 * Taller for every explicit break, and for every line long enough to wrap.
 *
 * `width` is the box the text has to wrap inside — a pinned node wraps to the width a human
 * dragged, not to the width its text would have asked for.
 */
export function estimateNodeHeight(text: string, width?: number): number {
  const usable = (width ?? estimateNodeWidth(text)) - PADDING_X;
  const lines = String(text ?? '')
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil((line.length * CHAR_ADVANCE) / usable)), 0);
  return NODE_HEIGHT + (Math.max(1, lines) - 1) * LINE_HEIGHT;
}

/**
 * The text a node's box has to hold: its label, plus its body when it has one.
 *
 * Everything estimating a node must use this rather than the label alone, or a node with
 * twenty lines of body is placed as though it were one line tall.
 */
export function nodeText(node: GraphNode): string {
  const label = String(node.data?.label ?? node.id);
  const body = node.data?.body;
  return typeof body === 'string' && body.length > 0 ? `${label}\n${body}` : label;
}

/**
 * How big a node actually is: its pinned size if it has one, otherwise its estimate.
 *
 * Everything that reasons about node geometry must go through here. A manually widened node
 * is *wider than its estimate*, so any code still estimating would place or align against a
 * footprint smaller than the box on screen — reintroducing the overlap that size-aware
 * placement was written to fix, by a different route.
 */
export function nodeSize(node: GraphNode): Size {
  const text = nodeText(node);
  if (node.size) {
    // A pinned size is a floor, not a cage. Text that outgrows the box makes the box taller
    // rather than being clipped — and the server has to agree, or placement measures the
    // pinned height while the browser renders something bigger, and the next node lands on
    // top of the overflow.
    return {
      w: node.size.w,
      h: Math.max(node.size.h, estimateNodeHeight(text, node.size.w)),
    };
  }
  return { w: estimateNodeWidth(text), h: estimateNodeHeight(text) };
}

/** Snap a pinned size to the grid, with a floor so a node cannot be dragged to nothing. */
export const snapSize = (size: Size): Size => ({
  w: Math.max(snap(size.w), MIN_NODE_WIDTH),
  // Deliberately no maximum. MAX_NODE_WIDTH caps *auto* sizing so a long label cannot run
  // away; a human overriding that is the entire point of resizing by hand.
  h: Math.max(snap(size.h), NODE_HEIGHT),
});

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const boxFor = (position: Position, node: GraphNode): Box => ({
  x: position.x,
  y: position.y,
  ...nodeSize(node),
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
  /** Its body, if it has one — a node with detail needs a bigger clearing than its name. */
  body?: string;
}

/**
 * Pick a free position for a new node.
 *
 * Anchors below the `near` node when given, otherwise to the right of the rightmost
 * existing node, otherwise the origin. Then walks down-and-right until it finds a spot
 * that collides with nothing.
 */
export function placeNode(nodes: GraphNode[], hint: PlacementHint = {}): Position {
  // Each existing node contributes its own real footprint — pinned size when it has one,
  // estimate otherwise — rather than a shared constant.
  const placed: Box[] = nodes.filter((n) => n.position != null).map((n) => boxFor(n.position!, n));

  const text = hint.body ? `${hint.label ?? ''}\n${hint.body}` : (hint.label ?? '');
  const own = { w: estimateNodeWidth(text), h: estimateNodeHeight(text) };
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
      // The anchor's real height, so a manually heightened node is cleared rather than
      // overlapped by whatever gets placed below it.
      const height = nodeSize(target).h;
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

/**
 * Which face of `from` a line to `to` should leave by.
 *
 * The same rule the canvas used to apply per frame, moved to the server so it runs *once*,
 * at creation. Recomputing it on every render is what made an arrow jump from one point to
 * another as a box was dragged past a diagonal.
 *
 * Each delta is weighted by the other dimension rather than compared raw: a 900px-wide node
 * is exited through its side long before the 45° line says so, and raw deltas put the arrow
 * on the top face of a box it is sitting beside.
 */
export function sideTowards(from: GraphNode, to: GraphNode): EdgeSide {
  const a = nodeSize(from);
  const b = nodeSize(to);
  // Positions are guaranteed after `normalize`, but the type is not — an unplaced node
  // reads as the origin rather than throwing, since a side is always answerable.
  const fp = from.position ?? { x: 0, y: 0 };
  const tp = to.position ?? { x: 0, y: 0 };
  const dx = tp.x + b.w / 2 - (fp.x + a.w / 2);
  const dy = tp.y + b.h / 2 - (fp.y + a.h / 2);

  if (Math.abs(dx) * a.h > Math.abs(dy) * a.w) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}
