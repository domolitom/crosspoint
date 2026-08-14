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

/**
 * Node colours, stored by name and never as a hex value.
 *
 * Colour here is meaning, not decoration — a red step says "this one is broken", and both
 * sides of the conversation need to read that. A name survives that trip; `#a3221c` does
 * not. Same principle as semantic layout ops: store the intent, not the rendered value.
 *
 * The concrete hex values live in the canvas CSS, which is the only place that needs them.
 */
export const NODE_COLORS = ['slate', 'amber', 'red', 'green', 'blue', 'violet'] as const;

export type NodeColor = (typeof NODE_COLORS)[number];

/** What an op may ask for. `none` clears the colour and is never itself stored. */
export type ColorInput = NodeColor | 'none';

export interface NodeData {
  label: string;
  /** Absent means uncoloured. An uncoloured node carries no colour key at all. */
  color?: NodeColor;
  /**
   * Name of another diagram holding this node's detail — a plan step's own sub-plan.
   *
   * A reference rather than nested content, so a subcanvas is an ordinary diagram: the
   * same file shape, the same ops, the same change feed, any depth for free. Nesting the
   * nodes inline would have made every op need a path instead of an id.
   *
   * Deliberately *not* called `diagram`: an op also carries a target diagram — which one
   * to write to — and two different meanings one word apart is a trap.
   */
  subcanvas?: string;
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

/** Which edge or axis a set of nodes is being lined up on. */
export const ALIGN_EDGES = [
  'left',
  'right',
  'top',
  'bottom',
  'center-x',
  'center-y',
] as const;

export type AlignEdge = (typeof ALIGN_EDGES)[number];

export const DISTRIBUTE_AXES = ['horizontal', 'vertical'] as const;

export type DistributeAxis = (typeof DISTRIBUTE_AXES)[number];

/** A node in a `generate_graph` payload. Carries no position — that is the point. */
export interface GeneratedNode {
  label: string;
  /** Defaults to the slugified label. Supply one when two nodes share a label. */
  id?: string;
  color?: ColorInput;
  data?: Record<string, unknown>;
}

/** An edge in a `generate_graph` payload, referring to nodes by their resolved ids. */
export interface GeneratedEdge {
  source: string;
  target: string;
  label?: string;
}

/**
 * Mutations, split by who is allowed to issue them.
 *
 * Structural ops carry no coordinates. They are the only ops exposed over MCP, which
 * is what makes it impossible for an agent to clobber a human's layout: the agent
 * cannot express a position, so it cannot overwrite one.
 */
export type StructuralOp =
  | {
      op: 'add_node';
      label: string;
      near?: string;
      color?: ColorInput;
      data?: Record<string, unknown>;
    }
  | { op: 'add_edge'; source: string; target: string; label?: string }
  | { op: 'reconnect_edge'; id: string; source: string; target: string }
  | {
      op: 'update_node';
      id: string;
      label?: string;
      /**
       * Colour is structural, not layout: recolouring destroys no spatial work, so an
       * agent setting it cannot damage an arrangement the way a coordinate could.
       */
      color?: ColorInput;
      /** Link this node to a diagram holding its detail. `none` unlinks without deleting. */
      subcanvas?: string | 'none';
      data?: Record<string, unknown>;
    }
  | { op: 'update_edge'; id: string; label?: string }
  | { op: 'delete_node'; id: string }
  | { op: 'delete_edge'; id: string }
  /**
   * Tidy an existing arrangement by naming intent rather than geometry.
   *
   * Structural for the purposes of *who may issue it* — no coordinate crosses the
   * boundary, so this is the agreed escape hatch that lets an agent tidy at all. But it
   * only moves boxes, so the change feed tags it `layout` and filters it as noise. That
   * is the one place `isLayoutOp` and `kindOf` deliberately disagree; see `changes.ts`.
   */
  | { op: 'align'; ids: string[]; edge: AlignEdge }
  | { op: 'distribute'; ids: string[]; axis: DistributeAxis }
  /**
   * Build a whole diagram in one op.
   *
   * Structural despite producing positions, and the distinction is the whole point: the
   * issuer supplies nodes, edges and labels, and the *server* runs the layout engine.
   * No coordinate crosses the boundary, so this is the "semantic intent, server resolves
   * geometry" escape hatch rather than a hole in the invariant — the same shape as an
   * `align` op.
   */
  | {
      op: 'generate_graph';
      nodes: GeneratedNode[];
      edges: GeneratedEdge[];
      /** Required to discard an existing diagram; without it a non-empty one is refused. */
      replace?: boolean;
    };

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
