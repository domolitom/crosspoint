import type { InternalNode } from '@xyflow/react';
import { borderPoint, EDGE_SIDES, MIDPOINT_MAGNET, type EdgeSide, type Position } from '@crosspoint/core';

/** One end of an edge on a node's border. No `at` is the side's predefined midpoint. */
export type EndPoint = { side: EdgeSide; at?: number };

export type Rect = { x: number; y: number; w: number; h: number };

/** Screen pixels of the grabbable band straddling each side. */
export const BAND = 8;

/** A plain side for a midpoint, `side:at` for anywhere else, so each point is its own handle. */
export const handleId = (side: EdgeSide, at?: number) => (at === undefined ? side : `${side}:${at}`);

export function parseHandle(id: string | null | undefined): EndPoint {
  const [side, at] = (id ?? '').split(':');
  const known = (EDGE_SIDES as readonly string[]).includes(side) ? (side as EdgeSide) : 'top';
  return at === undefined ? { side: known } : { side: known, at: Number(at) };
}

/** CSS placing an element on a point of its node's border, by percentage so it survives a resize. */
export function pointStyle({ side, at = 0.5 }: EndPoint) {
  const along = `${at * 100}%`;
  if (side === 'top') return { left: along, top: 0 };
  if (side === 'bottom') return { left: along, top: '100%' };
  if (side === 'left') return { left: 0, top: along };
  return { left: '100%', top: along };
}

export function pointOn(rect: Rect, { side, at = 0.5 }: EndPoint): Position {
  if (side === 'top') return { x: rect.x + rect.w * at, y: rect.y };
  if (side === 'bottom') return { x: rect.x + rect.w * at, y: rect.y + rect.h };
  if (side === 'left') return { x: rect.x, y: rect.y + rect.h * at };
  return { x: rect.x + rect.w, y: rect.y + rect.h * at };
}

export function rectOf(node: InternalNode): Rect {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? 0,
    h: node.measured.height ?? 0,
  };
}

/** The border point of `rect` nearest a flow-coordinate pointer, with the magnet scaled to the zoom. */
export const nearestPoint = (rect: Rect, pointer: Position, zoom: number): EndPoint =>
  borderPoint(rect, pointer, MIDPOINT_MAGNET / zoom);

/** The node a pointer is over, band included, and the point on its border it would land on. */
export function dropTarget(
  nodes: Iterable<InternalNode>,
  pointer: Position,
  zoom: number,
  exclude?: string,
): ({ id: string; rect: Rect } & EndPoint) | null {
  const pad = BAND / 2 / zoom;
  let hit: InternalNode | null = null;
  for (const node of nodes) {
    if (node.id === exclude) continue;
    const r = rectOf(node);
    const inside =
      pointer.x >= r.x - pad && pointer.x <= r.x + r.w + pad && pointer.y >= r.y - pad && pointer.y <= r.y + r.h + pad;
    // Later nodes render on top, so the last hit is the one under the cursor.
    if (inside) hit = node;
  }
  if (!hit) return null;
  const rect = rectOf(hit);
  return { id: hit.id, rect, ...nearestPoint(rect, pointer, zoom) };
}
