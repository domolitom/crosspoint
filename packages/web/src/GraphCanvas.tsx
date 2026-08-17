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
} from '@xyflow/react';
import type { Graph, GraphOp, NodeColor } from '@crosspoint/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CanvasNode } from './CanvasNode';
import { strokeFor } from './colors';
import { DirectedEdge } from './DirectedEdge';

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

/** Identifies our own palette drags, so unrelated drops onto the canvas are ignored. */
export const DRAG_TYPE = 'application/crosspoint-node';

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
          className: color ? `cp-color-${color}` : undefined,
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

  const onNodeDoubleClick = useCallback(
    (_: unknown, node: Node) => {
      const label = window.prompt('Label', String(node.data.label ?? ''));
      if (label != null && label.trim()) {
        emit({ op: 'update_node', id: node.id, label: label.trim() });
      }
    },
    [emit],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    // Without preventDefault the browser refuses the drop and no drop event fires.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();

      const label = window.prompt('New node label');
      // Cancelled prompt means no node — better than littering the canvas with
      // unnamed boxes someone has to go back and rename.
      if (!label?.trim()) return;

      // Screen pixels are meaningless to the graph: convert through the current pan
      // and zoom so the node lands where it was dropped, not where the viewport is.
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      emit({ op: 'add_node_at', label: label.trim(), position });
    },
    [screenToFlowPosition, emit],
  );

  return (
    <ReactFlow
      nodes={nodes}
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
      onDragOver={onDragOver}
      onDrop={onDrop}
      snapToGrid
      snapGrid={[15, 15]}
      fitView
    >
      <Background gap={15} />
      {variant === 'main' && <MiniMap pannable />}
      {variant === 'main' && <Controls />}
    </ReactFlow>
  );
}
