import type { NodeColor } from '@crosspoint/core';

/**
 * Edge stroke colours, by palette name.
 *
 * These have to live in JavaScript rather than CSS, unlike the node colours: an edge's
 * arrowhead is an SVG `<marker>` whose colour React Flow bakes into the marker definition,
 * and a stylesheet cannot reach it. A coloured line ending in a grey arrow reads as a bug,
 * so the value has to be available where `markerEnd` is built.
 *
 * The saturated tone, not the pale fill the nodes use for their background — a 1.5px line
 * in `#fef3c7` is invisible. These match the node *border* colours in `styles.css`, so an
 * amber node and an amber edge are recognisably the same amber.
 */
export const EDGE_STROKE: Record<NodeColor, string> = {
  slate: '#94a3b8',
  amber: '#d97706',
  red: '#dc2626',
  green: '#16a34a',
  blue: '#2563eb',
  violet: '#7c3aed',
};

/** An uncoloured edge. */
export const EDGE_DEFAULT = '#7b8494';

/** Selection tint for an edge with no colour of its own. */
export const EDGE_SELECTED = '#2563eb';

export const strokeFor = (color?: NodeColor): string =>
  (color && EDGE_STROKE[color]) || EDGE_DEFAULT;
