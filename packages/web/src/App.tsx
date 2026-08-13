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
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useRef, useState } from 'react';

import { DirectedEdge } from './DirectedEdge';
import { useGraph } from './useGraph';

const EDGE_COLOR = '#7b8494';
// Defined once at module scope: a new object each render remounts every edge.
const edgeTypes = { directed: DirectedEdge };

/** Identifies our own palette drags, so unrelated drops onto the canvas are ignored. */
const DRAG_TYPE = 'application/crosspoint-node';

export default function App() {
  // screenToFlowPosition comes from useReactFlow, which needs a provider above it.
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}

function Canvas() {
  const { graph, connected, error, sendOp } = useGraph();
  const { screenToFlowPosition } = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  /** Nodes the user is mid-drag on; server state must not yank them out from under. */
  const dragging = useRef(new Set<string>());

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
        return {
          id: node.id,
          position,
          data: { label: String(node.data.label ?? node.id) },
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
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: EDGE_COLOR },
          style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
          // One constant, not a per-edge sign: the normal is computed from the
          // source→target axis, which already points the opposite way for the reverse
          // edge. Flipping the sign as well would cancel that out and stack them again.
          data: {
            labelOffset: reciprocal ? 22 : 0,
            // Select-then-Delete is invisible unless you already know about it, so a
            // selected edge also offers a click target.
            onDelete: () => sendOp({ op: 'delete_edge', id: edge.id }),
          },
        };
      });
    });
  }, [graph, sendOp]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    // Selection changes arrive here. Without this, clicking an edge never marks it
    // selected, so Delete has nothing to act on and onEdgesDelete never fires.
    // Removals are applied locally too, but the server push is what makes them real.
    setEdges((es) => applyEdgeChanges(changes, es));
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Applied locally so dragging stays at 60fps. Only drag-stop is persisted —
    // intermediate positions are animation, not data.
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  // React Flow passes every dragged node as the third argument. Reading only the second
  // moved the whole selection on screen but persisted just the node under the cursor, so
  // the rest snapped back on the next server push — and only that one node was guarded
  // against an incoming edit mid-drag. `nodes` is empty for some single-node drags, hence
  // the fallback.
  const onNodeDragStart = useCallback((_: unknown, node: Node, nodes: Node[]) => {
    for (const dragged of nodes?.length ? nodes : [node]) dragging.current.add(dragged.id);
  }, []);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node, nodes: Node[]) => {
      // One narrow op per node rather than a batch op, consistent with everything else
      // here. N revs for one gesture is fine: persistence is debounced to a single write.
      for (const dragged of nodes?.length ? nodes : [node]) {
        dragging.current.delete(dragged.id);
        sendOp({ op: 'move_node', id: dragged.id, position: dragged.position });
      }
    },
    [sendOp],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      // No optimistic edge: the server assigns the id (`source->target`), and inventing a
      // local one would briefly render a duplicate that then gets replaced. Over a local
      // socket the round trip is imperceptible, and it keeps the server the only authority
      // on what exists — the same rule every other mutation here follows.
      if (connection.source && connection.target) {
        sendOp({ op: 'add_edge', source: connection.source, target: connection.target });
      }
    },
    [sendOp],
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, connection: Connection) => {
      // Same rule as onConnect: no optimistic update. The server regenerates the id from
      // the new endpoints, so a locally reconnected edge would carry a stale id until the
      // push replaced it.
      if (connection.source && connection.target) {
        sendOp({
          op: 'reconnect_edge',
          id: oldEdge.id,
          source: connection.source,
          target: connection.target,
        });
      }
    },
    [sendOp],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      for (const node of deleted) sendOp({ op: 'delete_node', id: node.id });
    },
    [sendOp],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const edge of deleted) sendOp({ op: 'delete_edge', id: edge.id });
    },
    [sendOp],
  );

  const onNodeDoubleClick = useCallback(
    (_: unknown, node: Node) => {
      const label = window.prompt('Label', String(node.data.label ?? ''));
      if (label != null && label.trim()) {
        sendOp({ op: 'update_node', id: node.id, label: label.trim() });
      }
    },
    [sendOp],
  );

  const onPaletteDragStart = useCallback((event: React.DragEvent) => {
    event.dataTransfer.setData(DRAG_TYPE, 'node');
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

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

      const label = window.prompt('New node label');
      // Cancelled prompt means no node — better than littering the canvas with
      // unnamed boxes someone has to go back and rename.
      if (!label?.trim()) return;

      // Screen pixels are meaningless to the graph: convert through the current pan
      // and zoom so the node lands where it was dropped, not where the viewport is.
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      sendOp({ op: 'add_node_at', label: label.trim(), position });
    },
    [screenToFlowPosition, sendOp],
  );

  return (
    <div className="app">
      <header className="bar">
        <strong>Crosspoint</strong>
        <div
          className="palette-node"
          draggable
          onDragStart={onPaletteDragStart}
          title="Drag onto the canvas to add a node"
        >
          Node
        </div>
        <span className="palette-hint">drag onto the canvas</span>
        <span className="spacer" />
        {error && <span className="error">{error}</span>}
        <span className="rev">rev {graph?.rev ?? '—'}</span>
        <span className={connected ? 'status ok' : 'status off'}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </header>

      <ReactFlow
        nodes={nodes}
        edges={edges}
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
        <MiniMap pannable />
        <Controls />
      </ReactFlow>
    </div>
  );
}
