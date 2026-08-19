import type { Graph, GraphOp } from '@crosspoint/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { GraphCanvas, type CanvasSelection } from './GraphCanvas';

/**
 * A subcanvas, floating over the canvas next to the node it belongs to.
 *
 * Anchored rather than replacing the view so the parent stays visible behind it — the
 * point is to see a step's detail *in the context of* the plan it belongs to.
 *
 * One panel at a time. Lensing deeper replaces the contents and pushes onto the trail,
 * which is what keeps arbitrary depth from turning into a heap of overlapping windows.
 */

const DEFAULT_SIZE = { w: 420, h: 320 };
const MIN_SIZE = { w: 260, h: 200 };

interface Size {
  w: number;
  h: number;
}

interface Placement {
  size: Size;
  /**
   * Where the user dragged the panel to, in viewport pixels. Absent means "anchored beside
   * the node", which is the default.
   *
   * Absolute rather than an offset from the anchor: the point of moving it is to get it out
   * of the way, and re-anchoring on the next open would undo exactly that. Double-clicking
   * the header clears it and returns to anchored.
   */
  at?: { x: number; y: number };
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * Panel size is remembered per diagram, in localStorage rather than in the graph.
 *
 * It is presentation state, the same category as zoom and scroll offset: it describes a
 * window, not the diagram inside it. Putting it in the graph file would push pixels of
 * chrome into what the agent reads and into the change feed, for something that is not
 * part of anyone's message. Keyed by diagram, not by node, because a dense subgraph wants
 * a big panel whichever node happens to link to it.
 */
const placementKey = (diagram: string) => `crosspoint.lens.size.${diagram}`;

function loadPlacement(diagram: string | undefined): Placement {
  if (!diagram) return { size: DEFAULT_SIZE };
  try {
    const raw = window.localStorage.getItem(placementKey(diagram));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Size> & { at?: { x: number; y: number } };
      const size =
        typeof parsed.w === 'number' && typeof parsed.h === 'number'
          ? { w: parsed.w, h: parsed.h }
          : DEFAULT_SIZE;
      const at =
        parsed.at && typeof parsed.at.x === 'number' && typeof parsed.at.y === 'number'
          ? parsed.at
          : undefined;
      return { size, at };
    }
  } catch {
    // A quota error or private-mode block must not stop the panel from opening.
  }
  return { size: DEFAULT_SIZE };
}

function savePlacement(diagram: string | undefined, placement: Placement): void {
  if (!diagram) return;
  try {
    // Flattened so an older entry that stored only { w, h } still reads back.
    const { size, at } = placement;
    window.localStorage.setItem(
      placementKey(diagram),
      JSON.stringify(at ? { ...size, at } : { ...size }),
    );
  } catch {
    // Losing a remembered placement is not worth surfacing an error for.
  }
}

export interface LensStep {
  /** Node whose badge was clicked, in the diagram one level up. */
  nodeId: string;
  label: string;
  diagram: string;
  /** Where to anchor: the node's position in *screen* pixels, captured on open. */
  anchor: { x: number; y: number };
}

export interface SubcanvasPanelProps {
  trail: LensStep[];
  graph: Graph | null;
  sendOp: (op: GraphOp, diagram?: string) => void;
  onLens: (node: { id: string; label: string; subcanvas?: string }) => void;
  onSelectionChange: (selected: CanvasSelection) => void;
  onBack: (depth: number) => void;
  onClose: () => void;
}

export function SubcanvasPanel({
  trail,
  graph,
  sendOp,
  onLens,
  onSelectionChange,
  onBack,
  onClose,
}: SubcanvasPanelProps) {
  const current = trail[trail.length - 1];
  const diagram = current?.diagram;

  // Hooks run before the early return below, so they cannot be called conditionally.
  const [placement, setPlacement] = useState<Placement>(() => loadPlacement(diagram));
  const size = placement.size;
  const latest = useRef(placement);
  latest.current = placement;
  /** Pointer origin and the size at grab time; null when not resizing. */
  const from = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Pointer origin and the panel corner at grab time; null when not moving. */
  const moveFrom = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // Lensing deeper swaps which diagram the panel shows, so pick up that one's placement.
  useEffect(() => {
    setPlacement(loadPlacement(diagram));
  }, [diagram]);

  const onResizeDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Without this the drag reaches the canvas underneath and starts a selection box.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    from.current = {
      x: event.clientX,
      y: event.clientY,
      w: latest.current.size.w,
      h: latest.current.size.h,
    };
  }, []);

  const onResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = from.current;
    if (!start) return;
    setPlacement((current) => ({
      ...current,
      size: {
        w: clamp(start.w + (event.clientX - start.x), MIN_SIZE.w, window.innerWidth - 32),
        h: clamp(start.h + (event.clientY - start.y), MIN_SIZE.h, window.innerHeight - 72),
      },
    }));
  }, []);

  const onResizeUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!from.current) return;
      from.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      // Persist on release rather than per frame: one write per gesture, not per pixel.
      savePlacement(diagram, latest.current);
    },
    [diagram],
  );

  /**
   * Drag the panel by its header.
   *
   * Anchoring alone was not enough: a panel beside its node covers the very part of the
   * parent it exists to keep visible. Only the bar itself starts a move — the crumbs and the
   * close button are buttons, and the body is a live canvas that must keep its own panning.
   */
  const onMoveDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // A click on a crumb or the close button is not a drag.
      if ((event.target as HTMLElement).closest('button')) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const box = event.currentTarget.parentElement?.getBoundingClientRect();
      moveFrom.current = {
        x: event.clientX,
        y: event.clientY,
        left: box?.left ?? 0,
        top: box?.top ?? 0,
      };
    },
    [],
  );

  const onMoveMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const start = moveFrom.current;
    if (!start) return;
    const { w, h } = latest.current.size;
    setPlacement((cur) => ({
      ...cur,
      // Clamped so it cannot be dragged off-screen and become unreachable.
      at: {
        x: clamp(start.left + (event.clientX - start.x), 0, window.innerWidth - w),
        y: clamp(start.top + (event.clientY - start.y), 0, window.innerHeight - h),
      },
    }));
  }, []);

  const onMoveUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!moveFrom.current) return;
      moveFrom.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      savePlacement(diagram, latest.current);
    },
    [diagram],
  );

  /** Double-click the bar to give up a dragged position and re-anchor to the node. */
  const onResetPlacement = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if ((event.target as HTMLElement).closest('button')) return;
      const next = { size: latest.current.size };
      setPlacement(next);
      savePlacement(diagram, next);
    },
    [diagram],
  );

  if (!current) return null;

  // Anchored beside the node, then clamped into the viewport so a node near the right or
  // bottom edge does not open a panel half off-screen. Uses the live size, so a resized
  // panel stays on screen rather than being clamped against its original dimensions.
  // A position the user dragged to wins over the anchor; clamped in case the window has
  // since been resized smaller than it was when they placed it.
  const left = placement.at
    ? clamp(placement.at.x, 0, Math.max(0, window.innerWidth - size.w))
    : Math.min(current.anchor.x + 24, window.innerWidth - size.w - 16);
  const top = placement.at
    ? clamp(placement.at.y, 0, Math.max(0, window.innerHeight - size.h))
    : Math.min(Math.max(current.anchor.y - 40, 56), window.innerHeight - size.h - 16);

  return (
    <aside
      className="lens-panel"
      style={{ left, top, width: size.w, height: size.h }}
      aria-label={`Subcanvas ${current.diagram}`}
    >
      <header
        className="lens-panel-bar"
        title="Drag to move, double-click to re-anchor"
        onPointerDown={onMoveDown}
        onPointerMove={onMoveMove}
        onPointerUp={onMoveUp}
        onPointerCancel={onMoveUp}
        onDoubleClick={onResetPlacement}
      >
        <nav className="lens-crumbs" aria-label="Subcanvas trail">
          {trail.map((step, index) => (
            <span key={`${step.diagram}-${index}`}>
              {index > 0 && <span className="lens-sep">›</span>}
              <button
                type="button"
                className="lens-crumb"
                // The last crumb is where we already are, so it does nothing.
                disabled={index === trail.length - 1}
                onClick={() => onBack(index + 1)}
                title={`Back to ${step.diagram}`}
              >
                {step.diagram}
              </button>
            </span>
          ))}
        </nav>
        <button type="button" className="lens-close" onClick={onClose} aria-label="Close subcanvas">
          ×
        </button>
      </header>

      <div className="lens-panel-body">
        {/* A real canvas, not a preview: drag, connect, delete and colour all work, and
            every op targets this diagram rather than the one behind it. */}
        <GraphCanvas
          graph={graph}
          diagram={current.diagram}
          sendOp={sendOp}
          onLens={onLens}
          onSelectionChange={onSelectionChange}
          variant="panel"
        />
      </div>

      <div
        className="lens-resize"
        role="separator"
        aria-label="Resize subcanvas"
        title="Drag to resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
    </aside>
  );
}
