import { useStoreApi, ViewportPortal, type Node, type NodeChange, type XYPosition } from '@xyflow/react';
import { GRID, snapToGuides, type Rect, type Snap } from '@crosspoint/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Screen pixels within which a dragged box snaps onto a guide. */
const SNAP_PX = 6;

const grid = (v: number) => Math.round(v / GRID) * GRID;
const size = (n?: Node) => ({ w: n?.measured?.width ?? 0, h: n?.measured?.height ?? 0 });

function bounds(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Snapping for a node drag: onto an alignment or spacing guide when one is in range, onto the
 * grid otherwise. React Flow's own grid snap is off, because it would snap a box off a guide.
 */
export function useGuides(isDragging: (id: string) => boolean) {
  const store = useStoreApi();
  const [snap, setSnap] = useState<Snap | null>(null);
  const alt = useRef(false);
  /** Where each dragged node was actually put, and whether a guide put it there. */
  const placed = useRef(new Map<string, { position: XYPosition; exact: boolean }>());

  useEffect(() => {
    const track = (event: KeyboardEvent | PointerEvent) => {
      alt.current = event.altKey;
    };
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    window.addEventListener('pointermove', track, true);
    return () => {
      window.removeEventListener('keydown', track);
      window.removeEventListener('keyup', track);
      window.removeEventListener('pointermove', track, true);
    };
  }, []);

  const apply = useCallback(
    (changes: NodeChange[], nodes: Node[]): NodeChange[] => {
      const moving = changes.filter(
        (c) => c.type === 'position' && c.position && (c.dragging || isDragging(c.id)),
      ) as (NodeChange & { type: 'position'; position: XYPosition })[];
      if (moving.length === 0) return changes;

      const ids = new Set(moving.map((c) => c.id));
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const box = bounds(moving.map((c) => ({ ...c.position, ...size(byId.get(c.id)) })));
      const others = nodes.filter((n) => !ids.has(n.id)).map((n) => ({ ...n.position, ...size(n) }));
      const zoom = store.getState().transform[2];

      const found = alt.current ? null : snapToGuides(box, others, SNAP_PX / zoom);
      const onX = Boolean(found && [...found.guides, ...found.gaps].some((g) => g.axis === 'x'));
      const onY = Boolean(found && [...found.guides, ...found.gaps].some((g) => g.axis === 'y'));
      const ending = moving.every((c) => !c.dragging);
      setSnap(!ending && (onX || onY) ? found : null);

      return changes.map((c) => {
        if (c.type !== 'position' || !c.position || !ids.has(c.id)) return c;
        const position = {
          x: onX ? c.position.x + found!.dx : grid(c.position.x),
          y: onY ? c.position.y + found!.dy : grid(c.position.y),
        };
        placed.current.set(c.id, { position, exact: onX || onY });
        return { ...c, position };
      });
    },
    [isDragging, store],
  );

  /** The position a drag left a node at, for the `move_node` it ends with. */
  const take = useCallback((id: string, fallback: XYPosition) => {
    const result = placed.current.get(id) ?? { position: fallback, exact: false };
    placed.current.delete(id);
    return result;
  }, []);

  const clear = useCallback(() => setSnap(null), []);

  return { apply, take, clear, snap };
}

/** The guide lines and gap markers, drawn in flow coordinates over the nodes. */
export function Guides({ snap }: { snap: Snap | null }) {
  if (!snap) return null;
  return (
    <ViewportPortal>
      {snap.guides.map((g, i) => (
        <div
          key={`g${i}`}
          className="cp-guide"
          style={
            g.axis === 'x'
              ? { left: g.at, top: g.from, height: g.to - g.from, width: 0 }
              : { left: g.from, top: g.at, width: g.to - g.from, height: 0 }
          }
        />
      ))}
      {snap.gaps.map((g, i) => (
        <div
          key={`s${i}`}
          className={`cp-gap cp-gap-${g.axis}`}
          style={
            g.axis === 'x'
              ? { left: g.from, top: g.at, width: g.to - g.from, height: 0 }
              : { left: g.at, top: g.from, height: g.to - g.from, width: 0 }
          }
        >
          <span className="cp-gap-label">{Math.round(g.to - g.from)}</span>
        </div>
      ))}
    </ViewportPortal>
  );
}
