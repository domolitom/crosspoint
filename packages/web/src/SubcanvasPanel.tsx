import type { Graph, GraphOp } from '@crosspoint/core';

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
  if (!current) return null;

  // Anchored beside the node, then clamped into the viewport so a node near the right or
  // bottom edge does not open a panel half off-screen.
  const width = 420;
  const height = 320;
  const left = Math.min(current.anchor.x + 24, window.innerWidth - width - 16);
  const top = Math.min(Math.max(current.anchor.y - 40, 56), window.innerHeight - height - 16);

  return (
    <aside
      className="lens-panel"
      style={{ left, top, width, height }}
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
    </aside>
  );
}
