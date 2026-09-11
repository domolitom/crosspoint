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

export interface Size {
  w: number;
  h: number;
}

export interface GraphNode {
  id: string;
  /** Absent means "not placed yet"; the server assigns one via placement. */
  position?: Position;
  /**
   * Absent means "size me from my label"; present means the human has pinned it.
   *
   * The same rule as `position`: the engine seeds, the human pins, and once pinned the
   * human's value wins permanently. A node nobody has resized carries no size key at all,
   * so it keeps tracking its text.
   *
   * A sibling of `position` rather than a member of `data` on purpose. `data` is the bag
   * `structuralView` hands to the agent, and node geometry has no business on that surface
   * — living out here means the existing read path excludes it without a special case.
   */
  size?: Size;
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

/**
 * Which ends of an edge carry an arrowhead.
 *
 * `forward` is the default and is never stored — an edge with no `arrow` key reads as an
 * ordinary directed edge, exactly as an edge with no `color` reads as uncoloured. `both`
 * says the two depend on each other; `none` is a plain association with no direction at all,
 * which the model previously could not express.
 */
export const EDGE_ARROWS = ['forward', 'both', 'none'] as const;

export type EdgeArrow = (typeof EDGE_ARROWS)[number];

/**
 * Which of a node's four connection points an edge end is attached to.
 *
 * Absent means "work it out from where the boxes are", which is what a generated graph
 * wants. Present means a human put it there, and it stays — the same bargain a node's
 * `size` strikes, and for the same reason: recomputing it made the arrow jump between
 * points mid-drag, which is not useful to anyone.
 *
 * `auto` is not a stored value. It is what an op passes to release the pin.
 */
export const EDGE_SIDES = ['top', 'right', 'bottom', 'left'] as const;

export type EdgeSide = (typeof EDGE_SIDES)[number];

export type SideInput = EdgeSide | 'auto';

export interface NodeData {
  /**
   * The node's name. One line, deliberately: ids are slugified from it, so a label with
   * line breaks in it produces ids nobody can refer to. Detail goes in `body`.
   */
  label: string;
  /**
   * Free multi-line text under the label. Absent means the node is just its name.
   *
   * Structural, like colour: what a node says is the message, not where it sits. Kept
   * apart from `label` so the change feed stays readable — a twenty-line body inlined into
   * `~ node x relabelled "..."` buries every other entry in the feed.
   */
  body?: string;
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
  /**
   * Absent means uncoloured. Flat rather than in a data bag, matching `label` — an edge
   * has no other per-edge state, and nesting one field would be noise in every diff.
   *
   * Shares the node palette: the same name means the same thing on either, so "red" reads
   * as one vocabulary across the diagram rather than two.
   */
  color?: NodeColor;
  /**
   * Absent means `forward`. Stored by name for the same reason colour is: a reader can
   * rely on it, and `arrow: "both"` says what an arrowhead flag never would.
   */
  arrow?: Exclude<EdgeArrow, 'forward'>;
  /** Pinned connection points. Absent on either end means that end is still computed. */
  sourceSide?: EdgeSide;
  targetSide?: EdgeSide;
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
  color?: ColorInput;
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
      /** Multi-line detail. An empty string clears it. */
      body?: string;
      color?: ColorInput;
      data?: Record<string, unknown>;
    }
  | {
      op: 'add_edge';
      source: string;
      target: string;
      label?: string;
      color?: ColorInput;
      /** Structural, like colour: which ends carry an arrowhead is a statement, not layout. */
      arrow?: EdgeArrow;
    }
  | { op: 'reconnect_edge'; id: string; source: string; target: string }
  | {
      op: 'update_node';
      id: string;
      label?: string;
      /**
       * Colour is structural, not layout: recolouring destroys no spatial work, so an
       * agent setting it cannot damage an arrangement the way a coordinate could.
       */
      /** Multi-line detail. An empty string clears it. */
      body?: string;
      color?: ColorInput;
      /** Link this node to a diagram holding its detail. `none` unlinks without deleting. */
      subcanvas?: string | 'none';
      data?: Record<string, unknown>;
    }
  | {
      op: 'update_edge';
      id: string;
      label?: string;
      /** Structural for the same reason node colour is: recolouring moves nothing. */
      color?: ColorInput;
      /** `forward` clears the key rather than storing the default. */
      arrow?: EdgeArrow;
    }
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
  | { op: 'add_node_at'; label: string; position: Position; data?: Record<string, unknown> }
  /** Pin a node's size. Pixels, so canvas-only — an agent cannot express one. */
  | { op: 'resize_node'; id: string; size: Size }
  /**
   * Draw an edge onto specific connection points.
   *
   * The canvas twin of `add_edge`, exactly as `add_node_at` is the twin of `add_node`: a
   * human dragging from one point to another has said where the ends go, and an agent has
   * not. Keeping the sides off `add_edge` is what stops an agent expressing them, and doing
   * it in one op is what keeps drawing an edge a single undo step.
   */
  | {
      op: 'add_edge_at';
      source: string;
      target: string;
      sourceSide: EdgeSide;
      targetSide: EdgeSide;
      label?: string;
    }
  /** Move an end to a different point on the same node, or release it back to automatic. */
  | { op: 'attach_edge'; id: string; source?: SideInput; target?: SideInput };

export type GraphOp = StructuralOp | LayoutOp;

const LAYOUT_OPS = new Set([
  'move_node',
  'add_node_at',
  'resize_node',
  'add_edge_at',
  'attach_edge',
]);

export const isLayoutOp = (op: GraphOp): op is LayoutOp => LAYOUT_OPS.has(op.op);
