import { alignNodes, distributeNodes } from './arrange.js';
import { GraphError } from './errors.js';
import { generateGraph } from './generate.js';
import { slugify, uniqueId } from './ids.js';
import { nodeSize, placeNode, sideTowards, snapPosition, snapSize } from './placement.js';
import {
  EDGE_ARROWS,
  EDGE_SIDES,
  NODE_COLORS,
  type ColorInput,
  type EdgeArrow,
  type EdgeSide,
  type SideInput,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GraphOp,
  type NodeData,
  type PlacedNode,
} from './types.js';

export { GraphError } from './errors.js';

/**
 * Reject an unknown colour rather than storing it.
 *
 * A validated field, not a free-form entry in the open `data` bag: the point of storing
 * names is that a reader can rely on them, which fails the moment `"crimsonish"` gets in.
 */
function requireColor(color: unknown): void {
  if (color === undefined || color === 'none') return;
  if (typeof color !== 'string' || !(NODE_COLORS as readonly string[]).includes(color)) {
    throw new GraphError(
      `Unknown colour "${String(color)}" — expected one of ${NODE_COLORS.join(', ')}, or "none"`,
    );
  }
}

/**
 * Fold a label / colour / data change into existing node data.
 *
 * The three are independent: relabelling must not drop a colour, and recolouring must not
 * reset a label to the node id. `none` removes the key entirely — an uncoloured node should
 * read as untouched in the file rather than carrying a `"none"` sentinel forever.
 */
function mergeNodeData(
  current: NodeData,
  change: {
    label?: string;
    color?: ColorInput;
    subcanvas?: string | 'none';
    data?: Record<string, unknown>;
  },
): NodeData {
  const data: NodeData = { ...current, ...change.data, label: change.label ?? current.label };
  // `none` deletes the key rather than storing a sentinel, so an unset node reads as
  // untouched in the file instead of carrying a marker into every diff.
  if (change.color === 'none') delete data.color;
  else if (change.color !== undefined) data.color = change.color;
  if (change.subcanvas === 'none') delete data.subcanvas;
  else if (change.subcanvas !== undefined) data.subcanvas = change.subcanvas;
  return data;
}

/**
 * Reject an unknown arrow rather than storing it — the same door `requireColor` guards.
 */
function requireArrow(arrow: unknown): void {
  if (arrow === undefined) return;
  if (typeof arrow !== 'string' || !(EDGE_ARROWS as readonly string[]).includes(arrow)) {
    throw new GraphError(
      `Unknown arrow "${String(arrow)}" — expected one of ${EDGE_ARROWS.join(', ')}`,
    );
  }
}

/** Reject an unknown side, the same door `requireColor` and `requireArrow` guard. */
function requireSide(side: unknown): void {
  if (side === undefined || side === 'auto') return;
  if (typeof side !== 'string' || !(EDGE_SIDES as readonly string[]).includes(side)) {
    throw new GraphError(
      `Unknown side "${String(side)}" — expected one of ${EDGE_SIDES.join(', ')}, or "auto"`,
    );
  }
}

/**
 * Fold a label / colour change into an existing edge.
 *
 * Independent, exactly as for nodes: relabelling must not drop a colour, and recolouring
 * must not clear a label. `none` removes the key so an uncoloured edge reads as untouched.
 */
function mergeEdge(
  current: GraphEdge,
  change: { label?: string; color?: ColorInput; arrow?: EdgeArrow },
): GraphEdge {
  const edge: GraphEdge = { ...current };
  // An empty label removes the key rather than storing `""`, matching how `color` and a
  // node's `subcanvas` clear. An edge with no text should read as untouched in the file,
  // not carry an empty string into every diff.
  if (change.label === '') delete edge.label;
  else if (change.label !== undefined) edge.label = change.label;
  if (change.color === 'none') delete edge.color;
  else if (change.color !== undefined) edge.color = change.color;
  // `forward` is the default, so it clears rather than stores — an ordinary edge should
  // read as untouched in the file.
  if (change.arrow === 'forward') delete edge.arrow;
  else if (change.arrow !== undefined) edge.arrow = change.arrow;
  return edge;
}

/**
 * Bring a graph into the invariant the server maintains: every node placed, no dangling
 * edges, no duplicate ids. Applied on load so a hand-edited file is always usable.
 */
export function normalize(graph: Graph): Graph {
  const seen = new Set<string>();
  const nodes: PlacedNode[] = [];

  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push({
      ...node,
      data: { ...node.data, label: node.data?.label ?? node.id },
      // Hand-written positions are passed through verbatim — loading a file must not
      // rewrite the human's coordinates. Snapping applies to drags and seeds only. A
      // hand-written `size` rides along in the spread for exactly the same reason: opening
      // a file must not resize what someone pinned by hand.
      position:
        node.position ?? placeNode(nodes, { label: String(node.data?.label ?? node.id) }),
    });
  }

  const edgeIds = new Set<string>();
  const kept = graph.edges.filter((edge) => {
    if (edgeIds.has(edge.id)) return false;
    if (!seen.has(edge.source) || !seen.has(edge.target)) return false;
    edgeIds.add(edge.id);
    return true;
  });

  // Seed the connection points the same way positions are seeded: an edge that has none
  // gets one now and keeps it. Leaving them absent means the canvas has to work them out
  // per frame, and an arrow that is recomputed is an arrow that jumps.
  const by = new Map(nodes.map((n) => [n.id, n]));
  const edges = kept.map((edge) => attachDefaults(edge, by));

  return { rev: graph.rev ?? 0, nodes, edges };
}

/**
 * Apply one mutation, returning a new graph with an incremented rev.
 *
 * Every op is narrow by construction: it names the one node or edge it touches and
 * leaves the rest of the document alone. That is what lets a human drag and an agent
 * restructure at the same time without either write clobbering the other.
 *
 * An op that asks for the state already held returns **the graph it was given** — same
 * reference, same rev — so a caller can tell "applied" from "changed nothing" with `===`.
 * Only the snapped layout ops can land there: the grid absorbs a sub-grid nudge or resize
 * down to the value already stored, so the comparison is an exact one on two snapped
 * values rather than a deep equality over the document.
 */
export function applyOp(graph: Graph, op: GraphOp): Graph {
  const next = { ...graph, rev: graph.rev + 1 };

  switch (op.op) {
    case 'add_node': {
      requireColor(op.color);
      const taken = new Set(graph.nodes.map((n) => n.id));
      const id = uniqueId(slugify(op.label), taken);
      const node: GraphNode = {
        id,
        position: placeNode(graph.nodes, { near: op.near, label: op.label }),
        data: mergeNodeData({ label: op.label }, op),
      };
      return { ...next, nodes: [...graph.nodes, node] };
    }

    case 'add_edge': {
      requireColor(op.color);
      requireArrow(op.arrow);
      const taken = new Set(graph.edges.map((e) => e.id));
      const id = uniqueId(`${op.source}->${op.target}`, taken);
      const source = requireNode(graph, op.source, 'source');
      const target = requireNode(graph, op.target, 'target');
      // Seeded by the server from where the boxes sit, exactly as `add_node` gets its
      // position from `placeNode`. The issuer named no geometry; the server resolved it.
      const edge: GraphEdge = {
        id,
        source: op.source,
        target: op.target,
        sourceSide: sideTowards(source, target),
        targetSide: sideTowards(target, source),
      };
      if (op.label) edge.label = op.label;
      if (op.color && op.color !== 'none') edge.color = op.color;
      if (op.arrow && op.arrow !== 'forward') edge.arrow = op.arrow;
      return { ...next, edges: [...graph.edges, edge] };
    }

    case 'reconnect_edge': {
      const existing = graph.edges.find((e) => e.id === op.id);
      if (!existing) throw new GraphError(`No edge with id "${op.id}"`);
      requireNode(graph, op.source, 'source');
      requireNode(graph, op.target, 'target');

      // Ids are derived from their endpoints, so an edge that now runs somewhere else
      // needs a new one — otherwise `auth->database` could describe an edge into the
      // cache, and the id stops being something an agent can reason about. Nothing
      // references edge ids, so regenerating is safe.
      const taken = new Set(graph.edges.filter((e) => e.id !== op.id).map((e) => e.id));
      const id = uniqueId(`${op.source}->${op.target}`, taken);
      const reconnected: GraphEdge = { id, source: op.source, target: op.target };
      // Everything the edge carried survives being pointed somewhere else. Moving an arrow
      // is not a reason to lose the label or the colour that said what it meant.
      if (existing.label !== undefined) reconnected.label = existing.label;
      if (existing.color !== undefined) reconnected.color = existing.color;
      if (existing.arrow !== undefined) reconnected.arrow = existing.arrow;
      // A pinned point only means something for the node it was pinned to. The end that
      // moved is now on a different box, so it goes back to automatic; the end that stayed
      // put keeps the point the human chose for it.
      const from = requireNode(graph, op.source, 'source');
      const to = requireNode(graph, op.target, 'target');
      reconnected.sourceSide =
        existing.source === op.source && existing.sourceSide !== undefined
          ? existing.sourceSide
          : sideTowards(from, to);
      reconnected.targetSide =
        existing.target === op.target && existing.targetSide !== undefined
          ? existing.targetSide
          : sideTowards(to, from);

      return {
        ...next,
        // Replaced in place rather than removed and appended, so array order stays
        // stable and the diff shows one edge changing instead of a reshuffle.
        edges: graph.edges.map((e) => (e.id === op.id ? reconnected : e)),
      };
    }

    case 'update_node': {
      requireNode(graph, op.id, 'id');
      requireColor(op.color);
      return {
        ...next,
        nodes: graph.nodes.map((n) =>
          n.id === op.id ? { ...n, data: mergeNodeData(n.data, op) } : n,
        ),
      };
    }

    case 'add_edge_at': {
      requireNode(graph, op.source, 'source');
      requireNode(graph, op.target, 'target');
      requireSide(op.sourceSide);
      requireSide(op.targetSide);
      const taken = new Set(graph.edges.map((e) => e.id));
      const id = uniqueId(`${op.source}->${op.target}`, taken);
      const edge: GraphEdge = {
        id,
        source: op.source,
        target: op.target,
        sourceSide: op.sourceSide,
        targetSide: op.targetSide,
      };
      if (op.label) edge.label = op.label;
      return { ...next, edges: [...graph.edges, edge] };
    }

    case 'attach_edge': {
      const existing = graph.edges.find((e) => e.id === op.id);
      if (!existing) throw new GraphError(`No edge with id "${op.id}"`);
      requireSide(op.source);
      requireSide(op.target);

      const attached: GraphEdge = { ...existing };
      // `auto` releases the pin rather than storing a sentinel, matching `none` for colour.
      if (op.source === 'auto') delete attached.sourceSide;
      else if (op.source !== undefined) attached.sourceSide = op.source as EdgeSide;
      if (op.target === 'auto') delete attached.targetSide;
      else if (op.target !== undefined) attached.targetSide = op.target as EdgeSide;

      // Nothing changed means nothing to record — the same contract `move_node` keeps when
      // a drag lands where the node already was.
      if (
        attached.sourceSide === existing.sourceSide &&
        attached.targetSide === existing.targetSide
      ) {
        return graph;
      }

      return {
        ...next,
        edges: graph.edges.map((e) => (e.id === op.id ? attached : e)),
      };
    }

    case 'update_edge': {
      if (!graph.edges.some((e) => e.id === op.id)) {
        throw new GraphError(`No edge with id "${op.id}"`);
      }
      requireColor(op.color);
      requireArrow(op.arrow);
      return {
        ...next,
        edges: graph.edges.map((e) => (e.id === op.id ? mergeEdge(e, op) : e)),
      };
    }

    case 'delete_node': {
      requireNode(graph, op.id, 'id');
      return {
        ...next,
        nodes: graph.nodes.filter((n) => n.id !== op.id),
        // Cascade: an edge to a deleted node would violate the no-dangling invariant.
        edges: graph.edges.filter((e) => e.source !== op.id && e.target !== op.id),
      };
    }

    case 'delete_edge': {
      if (!graph.edges.some((e) => e.id === op.id)) {
        throw new GraphError(`No edge with id "${op.id}"`);
      }
      return { ...next, edges: graph.edges.filter((e) => e.id !== op.id) };
    }

    case 'generate_graph': {
      for (const node of op.nodes) requireColor(node.color);
      for (const edge of op.edges) requireColor(edge.color);

      // Checked before any work, and `applyOp` is pure, so a refusal cannot leave the
      // diagram half-replaced. The count is in the message because the whole reason this
      // guard exists is to stop a sub-plan vanishing by accident — a reader needs to know
      // how much they are about to discard.
      if (!op.replace && graph.nodes.length > 0) {
        throw new GraphError(
          `Diagram has ${graph.nodes.length} nodes. Pass replace: true to discard them, ` +
            'or generate into a different diagram.',
        );
      }

      const { nodes, edges } = generateGraph(op.nodes, op.edges);
      // Seeded from dagre's own layout, so a generated diagram opens with its arrows already
      // on a sensible point and never recomputes them afterwards.
      const placed = new Map(nodes.map((n) => [n.id, n]));
      // One rev for the whole graph, however large. Forty separate add_node calls would
      // burn forty revs and forty file writes, and the canvas would flail through them.
      return { ...next, nodes, edges: edges.map((e) => attachDefaults(e, placed)) };
    }

    // Layout intent, resolved into geometry on this side of the boundary. The issuer named
    // no coordinate, which is why these are allowed on the agent's write surface at all.
    case 'align':
      return { ...alignNodes(graph, op.ids, op.edge), rev: next.rev };

    case 'distribute':
      return { ...distributeNodes(graph, op.ids, op.axis), rev: next.rev };

    case 'add_node_at': {
      // Same id generation as add_node; only the placement differs. The position comes
      // from a human dropping a box, so it is taken as given rather than seeded — but
      // still snapped, so dropped and agent-added nodes share one lattice.
      const taken = new Set(graph.nodes.map((n) => n.id));
      const id = uniqueId(slugify(op.label), taken);
      const node: GraphNode = {
        id,
        position: snapPosition(op.position),
        data: { ...op.data, label: op.label },
      };
      return { ...next, nodes: [...graph.nodes, node] };
    }

    case 'move_node': {
      const node = requireNode(graph, op.id, 'id');
      const position = snapPosition(op.position);
      // A nudge smaller than the grid snaps back to where the node already was, so this is
      // the position it already holds. Nothing changed; say so.
      if (node.position?.x === position.x && node.position?.y === position.y) return graph;
      return {
        ...next,
        nodes: graph.nodes.map((n) => (n.id === op.id ? { ...n, position } : n)),
      };
    }

    case 'resize_node': {
      const node = requireNode(graph, op.id, 'id');
      const size = snapSize(op.size);
      // Same as a sub-grid nudge, by the other axis. Note an *unsized* node never lands
      // here: acquiring a size is what pins it, and that is a real change however closely
      // the box matches the estimate it replaces.
      if (node.size?.w === size.w && node.size?.h === size.h) return graph;
      // Storing a size is what pins the node: from here on it keeps this box instead of
      // tracking its label, exactly as a stored position stops it being re-seeded.
      return {
        ...next,
        nodes: graph.nodes.map((n) => (n.id === op.id ? { ...n, size } : n)),
      };
    }
  }
}

/** Give an edge the points it is missing, from where its two nodes currently sit. */
function attachDefaults(edge: GraphEdge, nodes: Map<string, PlacedNode>): GraphEdge {
  if (edge.sourceSide && edge.targetSide) return edge;
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return edge;
  return {
    ...edge,
    sourceSide: edge.sourceSide ?? sideTowards(source, target),
    targetSide: edge.targetSide ?? sideTowards(target, source),
  };
}

/** Returns the node so a caller can compare against what it already holds. */
function requireNode(graph: Graph, id: string, field: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw new GraphError(`No node with id "${id}" (${field})`);
  return node;
}

/**
 * The agent-facing view: structure and labels, no coordinates.
 *
 * Positions are data the agent must preserve, not data it consumes — pixel values carry
 * no meaning for reasoning about a diagram and only cost tokens. Callers that genuinely
 * need geometry ask for it explicitly.
 */
export function structuralView(graph: Graph) {
  return {
    rev: graph.rev,
    nodes: graph.nodes.map((n) => ({ id: n.id, ...n.data })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.label ? { label: e.label } : {}),
      // Colour is meaning, so it belongs in the agent's view. Position does not.
      ...(e.color ? { color: e.color } : {}),
      ...(e.arrow ? { arrow: e.arrow } : {}),
    })),
  };
}
