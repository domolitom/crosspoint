/**
 * The canonical Crosspoint graph.
 *
 * Design note: `position` is optional on the wire and in hand-written files, but the
 * server normalises every node to a concrete position on load and on insert. That is
 * the "layout engine seeds, human pins" rule — a node may arrive without coordinates,
 * but it never stays without them.
 */

export interface Position {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  /** Absent means "not placed yet"; the server assigns one via placement. */
  position?: Position;
  data: NodeData;
}

export interface NodeData {
  label: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface Graph {
  /** Incremented by the server on every applied mutation. Stale writes are rejected. */
  rev: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A node with its position guaranteed — what the server holds after normalisation. */
export type PlacedNode = GraphNode & { position: Position };

export const emptyGraph = (): Graph => ({ rev: 0, nodes: [], edges: [] });

/**
 * Mutations, split by who is allowed to issue them.
 *
 * Structural ops carry no coordinates. They are the only ops exposed over MCP, which
 * is what makes it impossible for an agent to clobber a human's layout: the agent
 * cannot express a position, so it cannot overwrite one.
 */
export type StructuralOp =
  | { op: 'add_node'; label: string; near?: string; data?: Record<string, unknown> }
  | { op: 'add_edge'; source: string; target: string; label?: string }
  | { op: 'reconnect_edge'; id: string; source: string; target: string }
  | { op: 'update_node'; id: string; label?: string; data?: Record<string, unknown> }
  | { op: 'update_edge'; id: string; label?: string }
  | { op: 'delete_node'; id: string }
  | { op: 'delete_edge'; id: string };

/**
 * Layout ops carry coordinates. Issued by the canvas only — never exposed over MCP.
 *
 * The split is by *who may issue an op*, not by what it does. Creating a node at a
 * dropped point belongs here rather than on `add_node`, because a human dropping a box
 * has a position in mind and an agent adding one does not. Giving the structural
 * `add_node` a position field would let an agent express a coordinate, which is exactly
 * the guarantee this file exists to keep.
 */
export type LayoutOp =
  | { op: 'move_node'; id: string; position: Position }
  | { op: 'add_node_at'; label: string; position: Position; data?: Record<string, unknown> };

export type GraphOp = StructuralOp | LayoutOp;

const LAYOUT_OPS = new Set(['move_node', 'add_node_at']);

export const isLayoutOp = (op: GraphOp): op is LayoutOp => LAYOUT_OPS.has(op.op);
