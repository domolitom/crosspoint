import * as dagre from '@dagrejs/dagre';

import { GraphError } from './errors.js';
import { slugify, uniqueId } from './ids.js';
import { estimateNodeHeight, estimateNodeWidth, snapPosition } from './placement.js';
import type {
  GeneratedEdge,
  GeneratedNode,
  GraphEdge,
  NodeData,
  PlacedNode,
} from './types.js';

/**
 * Whole-graph layout, the one place a real layout engine is allowed to run.
 *
 * `placeNode` deliberately never moves an existing node, because re-solving a diagram
 * the human has arranged is the failure mode stored positions exist to prevent. This is
 * the agreed exception: every node here is brand new, so there is nothing arranged to
 * destroy. Seeding a fresh 40-node graph and re-solving an arranged one are different
 * acts, and only the second is forbidden.
 *
 * The dagre call is isolated in this module rather than reaching into `ops.ts`, so that
 * the parked split of `core` into `structure/` and `layout/` stays a file move.
 */

/** Vertical flow: sources above their targets, which is how a control flow graph reads. */
const RANK_DIRECTION = 'TB';
/** Gap between siblings in a rank, and between ranks. Roomier than the seed lattice. */
const NODE_SEPARATION = 40;
const RANK_SEPARATION = 70;

export interface GeneratedLayout {
  nodes: PlacedNode[];
  edges: GraphEdge[];
}

/**
 * Resolve a payload into placed nodes and identified edges.
 *
 * Throws rather than repairing: a payload whose edges cannot be resolved is a mistake
 * worth reporting, not something to silently half-apply.
 */
export function generateGraph(
  nodes: GeneratedNode[],
  edges: GeneratedEdge[],
): GeneratedLayout {
  const ids = resolveIds(nodes);
  const known = new Set(ids);

  for (const edge of edges) {
    if (!known.has(edge.source)) {
      throw new GraphError(`Edge source "${edge.source}" is not one of the nodes being generated`);
    }
    if (!known.has(edge.target)) {
      throw new GraphError(`Edge target "${edge.target}" is not one of the nodes being generated`);
    }
  }

  const positions = runDagre(nodes, ids, edges);

  return {
    nodes: nodes.map((node, index) => ({
      id: ids[index],
      position: positions[index],
      data: dataFor(node),
    })),
    edges: identifyEdges(edges),
  };
}

/**
 * Ids come from explicit values or slugified labels, and a collision is an error.
 *
 * Uniquifying would be wrong here, unlike in `add_node`. Two nodes labelled "validate"
 * would silently become `validate` and `validate-2`, and every edge naming `validate`
 * would attach to whichever one won — quietly wiring the graph wrong. Refusing makes the
 * agent say which it meant.
 */
function resolveIds(nodes: GeneratedNode[]): string[] {
  const seen = new Set<string>();
  return nodes.map((node) => {
    const id = node.id ?? slugify(node.label);
    if (seen.has(id)) {
      throw new GraphError(
        `Duplicate node id "${id}" in one payload — give each node an explicit id, ` +
          'because edges would otherwise be ambiguous',
      );
    }
    seen.add(id);
    return id;
  });
}

function dataFor(node: GeneratedNode): NodeData {
  const data: NodeData = { ...node.data, label: node.label };
  // `none` is an instruction to clear, and there is nothing to clear on a new node.
  if (node.color && node.color !== 'none') data.color = node.color;
  return data;
}

/** Edge ids follow the same `source->target` convention as `add_edge`. */
function identifyEdges(edges: GeneratedEdge[]): GraphEdge[] {
  const taken = new Set<string>();
  return edges.map((edge) => {
    const id = uniqueId(`${edge.source}->${edge.target}`, taken);
    taken.add(id);
    const result: GraphEdge = { id, source: edge.source, target: edge.target };
    if (edge.label) result.label = edge.label;
    return result;
  });
}

function runDagre(
  nodes: GeneratedNode[],
  ids: string[],
  edges: GeneratedEdge[],
): { x: number; y: number }[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: RANK_DIRECTION,
    nodesep: NODE_SEPARATION,
    ranksep: RANK_SEPARATION,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Real per-node sizes, never a shared constant. Passing one width made wide labels
  // overlap by 110px the last time this mistake was made, in the seed placer.
  const sizes = nodes.map((node) => ({
    width: estimateNodeWidth(node.label),
    height: estimateNodeHeight(node.label),
  }));
  ids.forEach((id, index) => g.setNode(id, { ...sizes[index] }));
  for (const edge of edges) g.setEdge(edge.source, edge.target);

  dagre.layout(g);

  return ids.map((id, index) => {
    const laid = g.node(id) as { x: number; y: number } | undefined;
    // Dagre reports the node *centre*; this model stores the top-left corner. Skipping
    // this conversion shifts everything by half a box and makes overlap checks lie.
    const centreX = laid?.x ?? 0;
    const centreY = laid?.y ?? 0;
    return snapPosition({
      x: centreX - sizes[index].width / 2,
      y: centreY - sizes[index].height / 2,
    });
  });
}
