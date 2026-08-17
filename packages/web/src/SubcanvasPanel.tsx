import type { Graph, GraphOp } from '@crosspoint/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { GraphCanvas } from './GraphCanvas';

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
const sizeKey = (diagram: string) => `crosspoint.lens.size.${diagram}`;

function loadSize(diagram: string | undefined): Size {
  if (!diagram) return DEFAULT_SIZE;
  try {
    const raw = window.localStorage.getItem(sizeKey(diagram));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Size>;
      if (typeof parsed.w === 'number' && typeof parsed.h === 'number') {
        return { w: parsed.w, h: parsed.h };
      }
    }
  } catch {
    // A quota error or private-mode block must not stop the panel from opening.
  }
  return DEFAULT_SIZE;
}

function saveSize(diagram: string | undefined, size: Size): void {
  if (!diagram) return;
  try {
    window.localStorage.setItem(sizeKey(diagram), JSON.stringify(size));
  } catch {
    // Losing a remembered size is not worth surfacing an error for.
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
  onSelectionChange: (ids: string[]) => void;
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
  const [size, setSize] = useState<Size>(() => loadSize(diagram));
  const latest = useRef(size);
  latest.current = size;
  /** Pointer origin and the size at grab time; null when not resizing. */
  const from = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // Lensing deeper swaps which diagram the panel shows, so pick up that one's size.
  useEffect(() => {
    setSize(loadSize(diagram));
  }, [diagram]);

  const onResizeDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Without this the drag reaches the canvas underneath and starts a selection box.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    from.current = {
      x: event.clientX,
      y: event.clientY,
      w: latest.current.w,
      h: latest.current.h,
    };
  }, []);

  const onResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = from.current;
    if (!start) return;
    setSize({
      w: clamp(start.w + (event.clientX - start.x), MIN_SIZE.w, window.innerWidth - 32),
      h: clamp(start.h + (event.clientY - start.y), MIN_SIZE.h, window.innerHeight - 72),
    });
  }, []);

  const onResizeUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!from.current) return;
      from.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      // Persist on release rather than per frame: one write per gesture, not per pixel.
      saveSize(diagram, latest.current);
    },
    [diagram],
  );

  if (!current) return null;

  // Anchored beside the node, then clamped into the viewport so a node near the right or
  // bottom edge does not open a panel half off-screen. Uses the live size, so a resized
  // panel stays on screen rather than being clamped against its original dimensions.
  const left = Math.min(current.anchor.x + 24, window.innerWidth - size.w - 16);
  const top = Math.min(Math.max(current.anchor.y - 40, 56), window.innerHeight - size.h - 16);

  return (
    <aside
      className="lens-panel"
      style={{ left, top, width: size.w, height: size.h }}
      aria-label={`Subcanvas ${current.diagram}`}
    >
      <header className="lens-panel-bar">
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
