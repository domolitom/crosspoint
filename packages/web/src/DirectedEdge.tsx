import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { NodeColor } from '@crosspoint/core';

import { EDGE_SELECTED } from './colors';

export type DirectedEdgeData = {
  /** Sends delete_edge. The edge disappears when the server pushes back, not on click. */
  onDelete?: () => void;
  /** This edge's assigned palette colour, if any. Absent means uncoloured. */
  color?: NodeColor;
  /**
   * Perpendicular shift for the label, in pixels.
   *
   * A→B and B→A take visibly different routes, but their midpoints land close enough that
   * the two labels stack and one becomes unreadable. Nudging them apart along the normal
   * keeps both legible without moving the lines off their handles.
   *
   * Note this cannot be done with `pathOptions.curvature`: React Flow ignores curvature
   * whenever the handles already face each other, using `0.5 * distance` instead.
   */
  labelOffset?: number;
};

export function DirectedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  markerEnd,
  style,
  data,
  selected,
}: EdgeProps<Edge<DirectedEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const offset = data?.labelOffset ?? 0;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  // Unit normal to the source→target axis.
  const x = labelX + (-dy / length) * offset;
  const y = labelY + (dx / length) * offset;

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
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={stroke} />
      <EdgeLabelRenderer>
        {label && (
          <div
            className={selected ? 'edge-label selected' : 'edge-label'}
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          >
            {label}
          </div>
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
