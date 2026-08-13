import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
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

export default function App() {
  const { graph, connected, error, sendOp } = useGraph();
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

    setEdges(
      graph.edges.map((edge) => {
        const reciprocal = pairs.has(`${edge.target}|${edge.source}`);
        return {
          id: edge.id,
          type: 'directed',
          source: edge.source,
          target: edge.target,
          label: edge.label,
          // The model has always been directed — source and target are not interchangeable.
          // The arrowhead just makes the canvas say what the data already says.
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: EDGE_COLOR },
          style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
          // One constant, not a per-edge sign: the normal is computed from the
          // source→target axis, which already points the opposite way for the reverse
          // edge. Flipping the sign as well would cancel that out and stack them again.
          data: { labelOffset: reciprocal ? 22 : 0 },
        };
      }),
    );
  }, [graph]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Applied locally so dragging stays at 60fps. Only drag-stop is persisted —
    // intermediate positions are animation, not data.
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    dragging.current.add(node.id);
  }, []);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      dragging.current.delete(node.id);
      sendOp({ op: 'move_node', id: node.id, position: node.position });
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

  const addNode = useCallback(() => {
    const label = window.prompt('New node label');
    // No position sent: the server seeds it. The canvas asks for a node, not a place.
    if (label?.trim()) sendOp({ op: 'add_node', label: label.trim() });
  }, [sendOp]);

  return (
    <div className="app">
      <header className="bar">
        <strong>Crosspoint</strong>
        <button onClick={addNode}>Add node</button>
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
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeDoubleClick={onNodeDoubleClick}
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
