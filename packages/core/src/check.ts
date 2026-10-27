import { groupRects } from './groups.js';
import { nodeSize, sideTowards } from './placement.js';
import type { EdgeSide, Graph, GraphEdge, GraphNode } from './types.js';

export type LayoutProblemKind = 'overlap' | 'through' | 'crossing' | 'stray' | 'long';

export interface LayoutProblem {
  kind: LayoutProblemKind;
  message: string;
  nodes: string[];
  edges: string[];
}

type Box = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };

/** An edge longer than this many times the median, and than `LONG_MIN` px, is reported. */
const LONG_FACTOR = 3;
const LONG_MIN = 300;
/** Lines graze a box's border at their own ends; only a real pass through counts. */
const INSET = 2;

const pointOn = (b: Box, side: EdgeSide, at = 0.5): Point =>
  side === 'top' ? { x: b.x + b.w * at, y: b.y }
  : side === 'bottom' ? { x: b.x + b.w * at, y: b.y + b.h }
  : side === 'left' ? { x: b.x, y: b.y + b.h * at }
  : { x: b.x + b.w, y: b.y + b.h * at };

const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const turn = (a: Point, b: Point, c: Point) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

/** Proper crossing only: segments that merely touch or run collinear do not count. */
const crosses = (p1: Point, p2: Point, q1: Point, q2: Point) =>
  turn(p1, p2, q1) * turn(p1, p2, q2) < 0 && turn(q1, q2, p1) * turn(q1, q2, p2) < 0;

/** Does the segment pass through the box's interior? Liang–Barsky clipping. */
function passesThrough(a: Point, b: Point, box: Box): boolean {
  const r = { x: box.x + INSET, y: box.y + INSET, w: box.w - 2 * INSET, h: box.h - 2 * INSET };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let lo = 0;
  let hi = 1;
  for (const [p, q] of [
    [-dx, a.x - r.x],
    [dx, r.x + r.w - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.h - a.y],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return false;
  }
  return true;
}

/** Problems a reader would notice, each naming the boxes and edges involved. Read-only. */
export function checkLayout(graph: Graph): LayoutProblem[] {
  const nodes = graph.nodes.filter((n) => n.position);
  const byId = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));
  const boxes = new Map<string, Box>(nodes.map((n) => [n.id, { ...n.position!, ...nodeSize(n) }]));
  const problems: LayoutProblem[] = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const [a, b] = [nodes[i].id, nodes[j].id];
      if (meets(boxes.get(a)!, boxes.get(b)!)) {
        problems.push({ kind: 'overlap', message: `boxes ${a} and ${b} overlap`, nodes: [a, b], edges: [] });
      }
    }
  }

  const lines = graph.edges.flatMap((e: GraphEdge) => {
    const [s, t] = [byId.get(e.source), byId.get(e.target)];
    if (!s || !t) return [];
    const from = pointOn(boxes.get(s.id)!, e.sourceSide ?? sideTowards(s, t), e.sourceAt);
    const to = pointOn(boxes.get(t.id)!, e.targetSide ?? sideTowards(t, s), e.targetAt);
    return [{ edge: e, from, to, length: Math.hypot(to.x - from.x, to.y - from.y) }];
  });

  for (const l of lines) {
    for (const n of nodes) {
      if (n.id === l.edge.source || n.id === l.edge.target) continue;
      if (passesThrough(l.from, l.to, boxes.get(n.id)!)) {
        problems.push({
          kind: 'through',
          message: `edge ${l.edge.id} runs through box ${n.id}`,
          nodes: [n.id],
          edges: [l.edge.id],
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const [p, q] = [lines[i], lines[j]];
      const ends = new Set([p.edge.source, p.edge.target]);
      if (ends.has(q.edge.source) || ends.has(q.edge.target)) continue;
      if (crosses(p.from, p.to, q.from, q.to)) {
        problems.push({
          kind: 'crossing',
          message: `edges ${p.edge.id} and ${q.edge.id} cross`,
          nodes: [],
          edges: [p.edge.id, q.edge.id],
        });
      }
    }
  }

  const containers = groupRects(nodes.map((n) => ({ ...boxes.get(n.id)!, group: n.data.group })));
  for (const c of containers) {
    for (const n of nodes) {
      if (n.data.group === c.name || !meets(c, boxes.get(n.id)!)) continue;
      problems.push({
        kind: 'stray',
        message: `box ${n.id} sits inside group ${c.name} without belonging to it`,
        nodes: [n.id],
        edges: [],
      });
    }
  }

  if (lines.length >= 4) {
    const sorted = lines.map((l) => l.length).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const l of lines) {
      if (l.length > LONG_FACTOR * median && l.length > LONG_MIN) {
        problems.push({
          kind: 'long',
          message: `edge ${l.edge.id} is ${Math.round(l.length / median)}x the median length`,
          nodes: [],
          edges: [l.edge.id],
        });
      }
    }
  }

  return problems;
}
