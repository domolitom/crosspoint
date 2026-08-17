import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import type { Graph, GraphOp, NodeColor, Position } from '@crosspoint/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CanvasNode } from './CanvasNode';
import { strokeFor } from './colors';
import { DirectedEdge } from './DirectedEdge';
import { LabelInput } from './LabelInput';

/**
 * One editable canvas over one diagram.
 *
 * Shared by the main canvas and the lens panel rather than duplicated, because the user's
 * requirement was that a subcanvas is *fully editable in place* — anything reimplemented
 * for the panel would drift out of step with the real one, and the drift would be silent.
 */

// Module scope: a fresh object each render remounts every node and edge.
const edgeTypes = { directed: DirectedEdge };
const nodeTypes = { default: CanvasNode };

export interface GraphCanvasProps {
  graph: Graph | null;
  /** Which diagram every op from this canvas targets. */
  diagram: string;
  sendOp: (op: GraphOp, diagram?: string) => void;
  /** Called when a node's lens badge is clicked. Omit to hide every badge. */
  onLens?: (node: { id: string; label: string; subcanvas?: string }) => void;
  /**
   * Nodes and edges are reported separately because colouring them takes different ops —
   * `update_node` against one, `update_edge` against the other. A flat list of ids would
   * leave the caller unable to tell which it was holding.
   */
  onSelectionChange?: (selected: CanvasSelection) => void;
  /** The panel drops the minimap and controls; there is no room for them. */
  variant?: 'main' | 'panel';
}

export interface CanvasSelection {
  nodes: string[];
  edges: string[];
}

export function GraphCanvas(props: GraphCanvasProps) {
  // Each canvas needs its own provider: useReactFlow resolves to the nearest one, and a
  // panel sharing the main canvas's store would pan and zoom it instead of itself.
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphCanvasInner({
  graph,
  diagram,
  sendOp,
  onLens,
  onSelectionChange,
  variant = 'main',
}: GraphCanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  /** Nodes the user is mid-drag on; server state must not yank them out from under. */
  const dragging = useRef(new Set<string>());
  /**
   * The unnamed node being typed. `screen` positions the overlay, `flow` becomes the op.
   *
   * A plain overlay rather than a React Flow node: a node kept outside the `nodes` state
   * never receives its `dimensions` change (applyNodeChanges drops unknown ids), so React
   * Flow leaves it at `visibility: hidden` forever — present, sized, and invisible.
   */
  const [draft, setDraft] = useState<{ screen: Position; flow: Position } | null>(null);
  /** Id of the node whose label is being edited in place. */
  const [editing, setEditing] = useState<string | null>(null);

  const emit = useCallback((op: GraphOp) => sendOp(op, diagram), [sendOp, diagram]);

  useEffect(() => {
    if (!graph) return;

    setNodes((prev) => {
      const previous = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((node) => {
        const local = previous.get(node.id);
        // A drag in flight is the freshest truth for that one node; everything else
        // takes the server's value. This is what keeps an agent's structural edit from
        // making the node you are holding jump back to its old spot.
        const position =
          local && dragging.current.has(node.id)
            ? local.position
            : (node.position ?? { x: 0, y: 0 });
        // Spread the whole data bag rather than picking out the label: anything else the
        // node carries — colour, a subcanvas reference — would otherwise be dropped on
        // every server push and silently vanish from the canvas.
        const color = node.data.color as NodeColor | undefined;
        const subcanvas = node.data.subcanvas as string | undefined;
        const label = String(node.data.label ?? node.id);
        return {
          id: node.id,
          position,
          data: {
            ...node.data,
            label,
            onLens: onLens ? () => onLens({ id: node.id, label, subcanvas }) : undefined,
          },
          // `cp-sized` releases the auto-sizing clamp. Inline width alone is not enough:
          // `max-width: 320px` still applies and silently pinned a 900px node back to 320,
          // so dragging a node wider appeared to snap back.
          className: [color ? `cp-color-${color}` : '', node.size ? 'cp-sized' : '']
            .filter(Boolean)
            .join(' ') || undefined,
          // A pinned size becomes explicit dimensions; an unpinned node gets none, so the
          // CSS `fit-content` clamp keeps sizing it from its label.
          ...(node.size ? { style: { width: node.size.w, height: node.size.h } } : {}),
          selected: local?.selected,
        };
      });
    });

    // A→B and B→A are two distinct edges whose default curves land almost on top of each
    // other, which hides one of the two labels. Pushing the labels to opposite sides of
    // their line separates them. Direction is only useful if you can tell which arrow a
    // label belongs to.
    const pairs = new Set(graph.edges.map((e) => `${e.source}|${e.target}`));

    setEdges((prev) => {
      const previous = new Map(prev.map((e) => [e.id, e]));
      return graph.edges.map((edge) => {
        const reciprocal = pairs.has(`${edge.target}|${edge.source}`);
        // The arrowhead takes the same colour as the line. React Flow bakes the colour into
        // the marker definition, so a stylesheet cannot reach it — leaving it out gives a
        // coloured edge ending in a grey arrow, which reads as a bug rather than a choice.
        const stroke = strokeFor(edge.color);
        return {
          id: edge.id,
          type: 'directed',
          source: edge.source,
          target: edge.target,
          label: edge.label,
          // Carried over explicitly: any push rebuilds this list, and dropping `selected`
          // would silently deselect the edge the user just clicked.
          selected: previous.get(edge.id)?.selected,
          // The model has always been directed — source and target are not interchangeable.
          // The arrowhead just makes the canvas say what the data already says.
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: stroke },
          style: { stroke, strokeWidth: 1.5 },
          // One constant, not a per-edge sign: the normal is computed from the
          // source→target axis, which already points the opposite way for the reverse
          // edge. Flipping the sign as well would cancel that out and stack them again.
          data: {
            labelOffset: reciprocal ? 22 : 0,
            // So the edge can keep its own colour while selected rather than being
            // overpainted with the selection tint.
            color: edge.color,
            // Select-then-Delete is invisible unless you already know about it, so a
            // selected edge also offers a click target.
            onDelete: () => emit({ op: 'delete_edge', id: edge.id }),
          },
        };
      });
    });
  }, [graph, emit, onLens]);

  // A switch replaces every node, so anything remembered about the old diagram is stale:
  // a mid-drag guard would strand a node id that no longer exists, and the viewport would
  // still be framing the graph we just left.
  useEffect(() => {
    dragging.current.clear();
    // Wait for the new nodes to have been measured, or fitView frames nothing.
    const timer = setTimeout(() => fitView({ duration: 200 }), 60);
    return () => clearTimeout(timer);
  }, [diagram, fitView]);

  /*
   * Selection is reported from both handlers, so each needs the other's current value.
   * Refs rather than state: these are read inside a setState callback, where reading state
   * would see the value from the render that installed the handler.
   */
  const selectedNodes = useRef<string[]>([]);
  const selectedEdges = useRef<string[]>([]);
  const reportSelection = useCallback(() => {
    onSelectionChange?.({ nodes: selectedNodes.current, edges: selectedEdges.current });
  }, [onSelectionChange]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Applied locally so dragging stays at 60fps. Only drag-stop is persisted —
      // intermediate positions are animation, not data.
      setNodes((ns) => {
        const next = applyNodeChanges(changes, ns);
        selectedNodes.current = next.filter((n) => n.selected).map((n) => n.id);
        reportSelection();
        return next;
      });
    },
    [reportSelection],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Selection changes arrive here. Without this, clicking an edge never marks it
      // selected, so Delete has nothing to act on and onEdgesDelete never fires.
      setEdges((es) => {
        const next = applyEdgeChanges(changes, es);
        selectedEdges.current = next.filter((e) => e.selected).map((e) => e.id);
        reportSelection();
        return next;
      });
    },
    [reportSelection],
  );

  // React Flow passes every dragged node as the third argument. Reading only the second
  // moved the whole selection on screen but persisted just the node under the cursor, so
  // the rest snapped back on the next server push. `nodes` is empty for some single-node
  // drags, hence the fallback.
  const onNodeDragStart = useCallback((_: unknown, node: Node, dragged: Node[]) => {
    for (const each of dragged?.length ? dragged : [node]) dragging.current.add(each.id);
  }, []);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node, dragged: Node[]) => {
      // One narrow op per node rather than a batch op, consistent with everything else
      // here. N revs for one gesture is fine: persistence is debounced to a single write.
      for (const each of dragged?.length ? dragged : [node]) {
        dragging.current.delete(each.id);
        emit({ op: 'move_node', id: each.id, position: each.position });
      }
    },
    [emit],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      // No optimistic edge: the server assigns the id (`source->target`), and inventing a
      // local one would briefly render a duplicate that then gets replaced. It keeps the
      // server the only authority on what exists — the rule every mutation here follows.
      if (connection.source && connection.target) {
        emit({ op: 'add_edge', source: connection.source, target: connection.target });
      }
    },
    [emit],
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, connection: Connection) => {
      if (connection.source && connection.target) {
        emit({
          op: 'reconnect_edge',
          id: oldEdge.id,
          source: connection.source,
          target: connection.target,
        });
      }
    },
    [emit],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      for (const node of deleted) emit({ op: 'delete_node', id: node.id });
    },
    [emit],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const edge of deleted) emit({ op: 'delete_edge', id: edge.id });
    },
    [emit],
  );

  const onNodeDoubleClick = useCallback((_: unknown, node: Node) => {
    setEditing(node.id);
  }, []);

  /**
   * Create by double-clicking empty canvas.
   *
   * v12 has no pane double-click callback, so this listens on the wrapper and filters to
   * events whose target is the pane — otherwise double-clicking a node to rename it would
   * also drop a new node behind it.
   */
  /*
   * Native, capture-phase, on the wrapper.
   *
   * React's `onDoubleClick` never fired: d3-zoom's handler on the pane stops propagation
   * during bubble, and React's listener sits at the root container above it. Capture runs
   * on the way down, before the pane sees the event at all.
   */
  const wrapper = useRef<HTMLDivElement>(null);

  const onDoubleClickCapture = useCallback(
    (event: MouseEvent) => {
      const target = event.target as Element;
      /*
       * Excluded by what it is *not*, deliberately.
       *
       * Testing for the pane positively does not work: `Background` renders an `<svg>` over
       * it, so the target is usually an SVG element whose `className` is an
       * `SVGAnimatedString` — `classList.contains('react-flow__pane')` is simply false, and
       * nothing happened. Ruling out the chrome is robust to React Flow's internals.
       */
      if (
        target.closest(
          '.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, input, button',
        )
      ) {
        return;
      }
      setEditing(null);
      const rect = wrapper.current?.getBoundingClientRect();
      setDraft({
        screen: { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) },
        flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      });
    },
    [screenToFlowPosition],
  );

  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    el.addEventListener('dblclick', onDoubleClickCapture, true);
    return () => el.removeEventListener('dblclick', onDoubleClickCapture, true);
  }, [onDoubleClickCapture]);

  /**
   * Commit the draft as a single `add_node_at`.
   *
   * The draft is client-side until it has a name. Creating an empty node and renaming it
   * would put `+ node ""` followed by `~ node relabelled` into the change feed for every
   * creation — noise in the one channel that exists to carry meaning — and an abandoned
   * draft would leave junk on the server needing a third op to clean up.
   */
  const commitDraft = useCallback(
    (label: string) => {
      if (draft) emit({ op: 'add_node_at', label, position: draft.flow });
      setDraft(null);
    },
    [draft, emit],
  );

  const commitRename = useCallback(
    (id: string, label: string) => {
      // LabelInput only calls this for a genuinely changed, non-empty label, so there is no
      // no-op op to guard against here.
      emit({ op: 'update_node', id, label });
      setEditing(null);
    },
    [emit],
  );

  const commitResize = useCallback(
    (id: string, size: { w: number; h: number }, position: { x: number; y: number }) => {
      emit({ op: 'resize_node', id, size });
      // Dragging a top or left handle grows the box *and* shifts its origin. The two are
      // separate facts in this model, so persist the move only when it actually happened —
      // resizing from the bottom-right stays a single op.
      const node = nodes.find((n) => n.id === id);
      if (node && (node.position.x !== position.x || node.position.y !== position.y)) {
        emit({ op: 'move_node', id, position });
      }
    },
    [emit, nodes],
  );

  /*
   * Edit state is layered on at render rather than baked into the graph sync above, which
   * only re-runs when the server pushes. Folding it in there would mean an edit either did
   * not appear until the next push, or forced a full node rebuild on every keystroke.
   */
  const displayNodes = useMemo(
    () =>
      nodes.map((node) => {
        const withResize = {
          ...node,
          data: {
            ...node.data,
            onResize: (size: { w: number; h: number }, position: { x: number; y: number }) =>
              commitResize(node.id, size, position),
          },
        };
        return node.id === editing
          ? {
              ...withResize,
              // React Flow's drag would fight the text caret.
              draggable: false,
              data: {
                ...withResize.data,
                editing: true,
                onRename: (label: string) => commitRename(node.id, label),
                onCancelRename: () => setEditing(null),
              },
            }
          : withResize;
      }),
    [nodes, editing, commitRename, commitResize],
  );

  return (
    <div className="canvas-wrapper" ref={wrapper}>
    <ReactFlow
      nodes={displayNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onReconnect={onReconnect}
      // Default is 10px, which makes the endpoint fiddly to grab on a curved edge.
      reconnectRadius={20}
      // Defaults to Backspace alone, so Delete — what most full keyboards offer —
      // silently did nothing.
      deleteKeyCode={['Backspace', 'Delete']}
      onNodesDelete={onNodesDelete}
      onEdgesDelete={onEdgesDelete}
      onNodeDoubleClick={onNodeDoubleClick}
      // Double-click creates a node, so it must not also zoom the canvas.
      zoomOnDoubleClick={false}
      snapToGrid
      snapGrid={[15, 15]}
      fitView
    >
      <Background gap={15} />
      {variant === 'main' && <MiniMap pannable />}
      {variant === 'main' && <Controls />}
    </ReactFlow>
      {draft && (
        <div
          className="cp-draft"
          style={{ left: draft.screen.x, top: draft.screen.y }}
        >
          <LabelInput
            ariaLabel="New node label"
            placeholder="Name it…"
            className="cp-node-input"
            onCommit={commitDraft}
            onCancel={() => setDraft(null)}
          />
        </div>
      )}
    </div>
  );
}
