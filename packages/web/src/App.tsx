import '@xyflow/react/dist/style.css';
import { NODE_COLORS, type ColorInput, type GraphOp } from '@crosspoint/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { GraphCanvas } from './GraphCanvas';
import { LabelInput } from './LabelInput';
import { SubcanvasPanel, type LensStep } from './SubcanvasPanel';
import { useGraph } from './useGraph';

export default function App() {
  const {
    graph,
    graphs,
    diagram,
    diagrams,
    connected,
    error,
    setError,
    sendOp,
    revert,
    loadDiagram,
    switchDiagram,
    createDiagram,
  } = useGraph();

  /**
   * The current selection *and which diagram it lives in*.
   *
   * The palette lives in the header but the selection may be inside a panel, so the
   * diagram has to travel with it — colouring a panel node must write to that subcanvas,
   * not to whatever happens to be active behind it.
   */
  const [selection, setSelection] = useState<{
    diagram: string;
    nodes: string[];
    edges: string[];
  }>({ diagram: '', nodes: [], edges: [] });
  /** True while the header is asking for a new diagram name. */
  const [naming, setNaming] = useState(false);
  /** The open lens, deepest last. Empty means no panel. */
  const [trail, setTrail] = useState<LensStep[]>([]);

  const selectedCount = selection.nodes.length + selection.edges.length;

  const closePanel = useCallback(() => setTrail([]), []);

  /**
   * Cmd+Z / Ctrl+Z to undo, Cmd+Shift+Z or Ctrl+Y to redo.
   *
   * Bound on the document rather than the canvas: the target depends on which canvas the
   * user was working in, which App knows and neither canvas does. Read through a ref so the
   * listener is attached once instead of being torn down on every trail change.
   */
  const undoTarget = useRef<string>('');
  undoTarget.current = trail.length ? trail[trail.length - 1].diagram : diagram ?? '';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;

      /*
       * Never while a text field has focus.
       *
       * Cmd+Z in an input must be the browser's own text undo. Reverting the graph instead
       * would be both surprising and destructive — you are mid-rename, so the node you are
       * renaming is the thing that would disappear.
       */
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      // Ctrl+Y as well, because that is what Windows users reach for.
      const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.metaKey);
      if (key !== 'z' && !(key === 'y' && !event.metaKey)) return;

      event.preventDefault();
      revert(redo ? 'redo' : 'undo', undoTarget.current || undefined);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [revert]);

  /**
   * Open a node's subcanvas, creating one if it has none.
   *
   * The trail is what makes arbitrary depth work with a single panel, and it is also what
   * lets the two circular cases be refused: a diagram cannot be its own detail, and it
   * cannot appear twice in one path.
   */
  const openLens = useCallback(
    async (node: { id: string; label: string; subcanvas?: string }, parent: string) => {
      const anchor = lensAnchor(node.id);
      let name = node.subcanvas;

      if (!name) {
        // Derived, not asked for. Interrupting the gesture to confirm a value we already
        // computed is exactly the friction being removed; a name can be changed later.
        name = `${slug(node.label) || node.id}-detail`;

        // Create then link. A name already in use is fine to adopt — reusing an existing
        // diagram as a node's detail is a reasonable thing to want.
        const res = await fetch('/api/diagrams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          // Anything other than "already exists" is a real failure worth surfacing.
          if (!/already exists/i.test(body.error ?? '')) {
            setError(body.error ?? 'Could not create the subcanvas');
            return;
          }
        }
        sendOp({ op: 'update_node', id: node.id, subcanvas: name }, parent);
      }

      // Two live editable views of one graph would each fight the other's pushes, and the
      // trail would stop meaning anything.
      if (name === diagram) {
        setError(`"${name}" is the diagram you are already in — open a different one.`);
        return;
      }
      if (trail.some((step) => step.diagram === name)) {
        setError(`"${name}" is already open further up this trail.`);
        return;
      }

      if (!graphs[name] && !(await loadDiagram(name))) return;

      setError(null);
      setTrail((prev) => [...prev, { nodeId: node.id, label: node.label, diagram: name!, anchor }]);
    },
    [diagram, trail, graphs, loadDiagram, sendOp, setError],
  );

  // Lensing from the main canvas starts a fresh trail; lensing inside the panel extends it.
  const onLensFromMain = useCallback(
    (node: { id: string; label: string; subcanvas?: string }) => {
      if (!diagram) return;
      setTrail([]);
      void openLens(node, diagram);
    },
    [diagram, openLens],
  );

  const onLensFromPanel = useCallback(
    (node: { id: string; label: string; subcanvas?: string }) => {
      const current = trail[trail.length - 1];
      if (current) void openLens(node, current.diagram);
    },
    [trail, openLens],
  );

  // Colour applies to the whole selection, so colouring three things emits three narrow
  // ops — the same shape as a multi-node drag. Nodes and edges take different ops, and a
  // mixed selection gets both.
  const applyColor = useCallback(
    (color: ColorInput) => {
      const target = selection.diagram || undefined;
      for (const id of selection.nodes) sendOp({ op: 'update_node', id, color }, target);
      for (const id of selection.edges) sendOp({ op: 'update_edge', id, color }, target);
    },
    [selection, sendOp],
  );

  const onCreateDiagram = useCallback(
    (name: string) => {
      setNaming(false);
      void createDiagram(name);
    },
    [createDiagram],
  );

  const current = trail[trail.length - 1];

  return (
    <div className="app">
      <header className="bar">
        <strong>Crosspoint</strong>

        {/* Which diagram is active is server state; showing it stops that being hidden. */}
        <select
          className="diagram-switcher"
          aria-label="Active diagram"
          value={diagram ?? ''}
          onChange={(event) => {
            closePanel();
            void switchDiagram(event.target.value);
          }}
          disabled={diagrams.length === 0}
        >
          {diagrams.map((option) => (
            <option key={option.name} value={option.name}>
              {option.name} ({option.nodes})
            </option>
          ))}
        </select>
        {naming ? (
          <LabelInput
            ariaLabel="New diagram name"
            placeholder="Diagram name…"
            className="cp-diagram-input"
            onCommit={onCreateDiagram}
            onCancel={() => setNaming(false)}
          />
        ) : (
          <button
            type="button"
            className="new-diagram"
            title="New diagram"
            onClick={() => setNaming(true)}
          >
            +
          </button>
        )}

        <span className="palette-hint">double-click the canvas to add a node</span>

        <div
          className="colours"
          role="group"
          aria-label="Colour"
          title={
            selectedCount
              ? `Colour ${selectedCount} selected item${selectedCount > 1 ? 's' : ''}`
              : 'Select a node or edge first'
          }
        >
          {NODE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`swatch cp-swatch-${color}`}
              aria-label={color}
              disabled={selectedCount === 0}
              onClick={() => applyColor(color)}
            />
          ))}
          <button
            type="button"
            className="swatch swatch-clear"
            aria-label="no colour"
            disabled={selectedCount === 0}
            onClick={() => applyColor('none')}
          >
            ×
          </button>
        </div>

        <span className="spacer" />
        {error && <span className="error">{error}</span>}
        <span className="rev">rev {graph?.rev ?? '—'}</span>
        <span className={connected ? 'status ok' : 'status off'}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </header>

      <div className="canvas-area">
        {diagram && (
          <GraphCanvas
            graph={graph}
            diagram={diagram}
            sendOp={sendOp}
            onLens={onLensFromMain}
            onSelectionChange={(sel) => setSelection({ diagram, ...sel })}
          />
        )}

        {current && (
          <SubcanvasPanel
            trail={trail}
            graph={graphs[current.diagram] ?? null}
            sendOp={sendOp}
            onLens={onLensFromPanel}
            onSelectionChange={(sel) => setSelection({ diagram: current.diagram, ...sel })}
            onBack={(depth) => setTrail((prev) => prev.slice(0, depth))}
            onClose={closePanel}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Where to anchor the panel: beside the node whose badge was clicked.
 *
 * Read from the DOM rather than from graph coordinates because the panel is positioned in
 * screen pixels, and converting would have to account for the current pan and zoom.
 */
function lensAnchor(nodeId: string): { x: number; y: number } {
  const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  const box = el?.getBoundingClientRect();
  if (!box) return { x: 120, y: 120 };
  return { x: box.right, y: box.top };
}

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
