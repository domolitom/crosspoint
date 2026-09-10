import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node as FlowNode,
} from '@xyflow/react';
import type { EdgeSide, NodeColor } from '@crosspoint/core';

import { LabelInput } from './LabelInput';

import { EDGE_SELECTED } from './colors';

export type DirectedEdgeData = {
  /** Sends delete_edge. The edge disappears when the server pushes back, not on click. */
  onDelete?: () => void;
  /** This edge's assigned palette colour, if any. Absent means uncoloured. */
  color?: NodeColor;
  /**
   * How far apart to bow a reciprocal pair, in pixels.
   *
   * A→B and B→A choose the same two faces, so without this they are one line carrying two
   * labels. It bends the curve; the ends stay on their connection points.
   */
  offset?: number;
  /**
   * Pinned connection points. Absent means that end follows the arrangement.
   *
   * Recomputing a pinned end is the whole bug this exists to stop: the arrow jumped from
   * one point to another as a box was dragged past a diagonal.
   */
  sourceSide?: EdgeSide;
  targetSide?: EdgeSide;
  /** True while this edge's label is being edited in place. */
  editing?: boolean;
  /** Called with the new text. An empty string means "remove the label". */
  onLabelCommit?: (label: string) => void;
  onLabelCancel?: () => void;
};

type Rect = { x: number; y: number; w: number; h: number };
type Anchor = { x: number; y: number; position: Position };

function rectOf(node: InternalNode<FlowNode> | undefined): Rect | null {
  const w = node?.measured?.width;
  const h = node?.measured?.height;
  if (!node || !w || !h) return null;
  const { x, y } = node.internals.positionAbsolute;
  return { x, y, w, h };
}

/**
 * The point on `from` where a line to `to` leaves the box, snapped to the middle of a face.
 *
 * The comparison weights each delta by the *other* dimension rather than comparing them
 * raw: a 900px-wide pinned node is exited through its side long before the 45° line says
 * so, and using raw deltas puts the arrow on the top face of a box it is beside.
 */
function anchorOf(from: Rect, to: Rect): Anchor {
  const fx = from.x + from.w / 2;
  const fy = from.y + from.h / 2;
  const dx = to.x + to.w / 2 - fx;
  const dy = to.y + to.h / 2 - fy;

  if (Math.abs(dx) * from.h > Math.abs(dy) * from.w) {
    return dx > 0
      ? { x: from.x + from.w, y: fy, position: Position.Right }
      : { x: from.x, y: fy, position: Position.Left };
  }
  return dy > 0
    ? { x: fx, y: from.y + from.h, position: Position.Bottom }
    : { x: fx, y: from.y, position: Position.Top };
}

/** The point in the middle of one named face. */
function pointOn(rect: Rect, side: EdgeSide): Anchor {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.w / 2, y: rect.y, position: Position.Top };
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2, position: Position.Right };
    case 'bottom':
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h, position: Position.Bottom };
    case 'left':
      return { x: rect.x, y: rect.y + rect.h / 2, position: Position.Left };
  }
}

/** Which way is out of a face. Used to leave the box perpendicular to the side it starts on. */
const OUTWARD: Record<Position, readonly [number, number]> = {
  [Position.Top]: [0, -1],
  [Position.Right]: [1, 0],
  [Position.Bottom]: [0, 1],
  [Position.Left]: [-1, 0],
};

/**
 * A curve between two connection points.
 *
 * `bow` separates a reciprocal pair by displacing the *control* points, never the ends: an
 * end that drifts off its face lands on a corner, which is the bug this replaced. The normal
 * already reverses for the opposite edge, so one positive constant pulls the two apart.
 */
function curve(from: Anchor, to: Anchor, bow: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  // Capped, or distant nodes are joined by a balloon rather than a line.
  const reach = Math.min(length * 0.35, 140);

  const [ox, oy] = OUTWARD[from.position];
  const [tx, ty] = OUTWARD[to.position];
  const nx = (-dy / length) * bow;
  const ny = (dx / length) * bow;

  const c1 = { x: from.x + ox * reach + nx, y: from.y + oy * reach + ny };
  const c2 = { x: to.x + tx * reach + nx, y: to.y + ty * reach + ny };

  return [
    `M ${from.x},${from.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`,
    (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  ] as const;
}

export function DirectedEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  markerEnd,
  markerStart,
  style,
  data,
  selected,
}: EdgeProps<Edge<DirectedEdgeData>>) {
  const sourceRect = rectOf(useInternalNode(source));
  const targetRect = rectOf(useInternalNode(target));

  // Before the first measurement there is no box to reason about, so fall back to whatever
  // handle React Flow bound the edge to rather than drawing from a guessed origin.
  const ends =
    sourceRect && targetRect
      ? {
          from: data?.sourceSide
            ? pointOn(sourceRect, data.sourceSide)
            : anchorOf(sourceRect, targetRect),
          to: data?.targetSide
            ? pointOn(targetRect, data.targetSide)
            : anchorOf(targetRect, sourceRect),
        }
      : {
          from: { x: sourceX, y: sourceY, position: sourcePosition },
          to: { x: targetX, y: targetY, position: targetPosition },
        };

  const [path, x, y] = curve(ends.from, ends.to, data?.offset ?? 0);

  /*
   * Selection thickens the line but never repaints a coloured one.
   *
   * The palette acts on the current selection, so the edge you just coloured is selected by
   * definition. Overriding the stroke would make applying a colour appear to do nothing
   * until you clicked away — which reads as "edge colouring is broken". An uncoloured edge
   * has no colour to preserve, so it keeps the blue selection tint.
   */
  const stroke = selected
    ? { ...style, stroke: data?.color ? style?.stroke : EDGE_SELECTED, strokeWidth: 3 }
    : style;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} markerStart={markerStart} style={stroke} />
      <EdgeLabelRenderer>
        {data?.editing ? (
          /* Editing sits exactly where the label sits, so the text does not appear to move
             when you start typing. `edge-label` is click-through, so the editing wrapper
             needs its own class to be focusable at all. */
          <div
            className="edge-label editing"
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          >
            <LabelInput
              initial={label ? String(label) : ''}
              placeholder="label"
              ariaLabel="Edge label"
              className="cp-edge-input"
              autoWidth
              allowEmpty
              onCommit={(next) => data.onLabelCommit?.(next)}
              onCancel={() => data.onLabelCancel?.()}
            />
          </div>
        ) : (
          label && (
            <div
              className={selected ? 'edge-label selected' : 'edge-label'}
              style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
            >
              {label}
            </div>
          )
        )}
        {selected && data?.onDelete && (
          <button
            className="edge-delete"
            title="Remove this edge"
            // Sits just above the label so it never covers the text.
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y - 20}px)` }}
            onClick={(event) => {
              event.stopPropagation();
              data.onDelete!();
            }}
          >
            ×
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
