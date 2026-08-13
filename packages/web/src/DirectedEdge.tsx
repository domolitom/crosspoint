import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';

export type DirectedEdgeData = {
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

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
