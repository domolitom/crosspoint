import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkLayout } from './check.js';
import { applyOp } from './ops.js';
import { emptyGraph, type Graph, type GraphOp } from './types.js';

const build = (...ops: GraphOp[]): Graph => ops.reduce(applyOp, emptyGraph());
const at = (label: string, x: number, y: number): GraphOp => ({ op: 'add_node_at', label, position: { x, y } });
const edge = (source: string, target: string, sourceSide = 'right', targetSide = 'left'): GraphOp =>
  ({ op: 'add_edge_at', source, target, sourceSide, targetSide }) as GraphOp;
const kinds = (g: Graph) => checkLayout(g).map((p) => p.kind);

test('a clean diagram reports nothing', () => {
  const g = build(at('A', 0, 0), at('B', 300, 0), at('C', 600, 0), edge('a', 'b'), edge('b', 'c'));
  assert.deepEqual(checkLayout(g), []);
});

test('overlapping boxes are named', () => {
  const g = build(at('A', 0, 0), at('B', 30, 15));
  const [p] = checkLayout(g);
  assert.equal(p.kind, 'overlap');
  assert.deepEqual(p.nodes, ['a', 'b']);
  assert.match(p.message, /a.*b.*overlap/);
});

test('two edges that cross are named', () => {
  // A→D runs down-right while B→C runs up-right, through the same middle.
  const g = build(
    at('A', 0, 0), at('B', 0, 300), at('C', 600, 0), at('D', 600, 300),
    edge('a', 'd'), edge('b', 'c'),
  );
  const p = checkLayout(g).find((x) => x.kind === 'crossing')!;
  assert.deepEqual(p.edges, ['a->d', 'b->c']);
});

test('edges that only share a box do not count as crossing', () => {
  const g = build(at('A', 0, 150), at('B', 400, 0), at('C', 400, 300), edge('a', 'b'), edge('a', 'c'));
  assert.ok(!kinds(g).includes('crossing'));
});

test('an edge running through a box it does not connect is named', () => {
  const g = build(at('A', 0, 0), at('Wall', 300, 0), at('B', 600, 0), edge('a', 'b'));
  const p = checkLayout(g).find((x) => x.kind === 'through')!;
  assert.deepEqual([p.edges, p.nodes], [['a->b'], ['wall']]);
});

test('an edge far longer than the rest is named', () => {
  const g = build(
    at('A', 0, 0), at('B', 240, 0), at('C', 480, 0), at('D', 720, 0), at('Far', 4000, 0),
    edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'far'),
  );
  const long = checkLayout(g).filter((x) => x.kind === 'long');
  assert.deepEqual(long.map((p) => p.edges), [['d->far']]);
});

test('a box sitting inside another group is named', () => {
  const g = build(
    at('A', 0, 0), at('B', 300, 0), at('Stray', 150, 0),
    { op: 'update_node', id: 'a', group: 'Backend' },
    { op: 'update_node', id: 'b', group: 'Backend' },
  );
  const p = checkLayout(g).find((x) => x.kind === 'stray')!;
  assert.deepEqual(p.nodes, ['stray']);
  assert.match(p.message, /Backend/);
});

test('a generated diagram checks clean', () => {
  const g = applyOp(emptyGraph(), {
    op: 'generate_graph',
    nodes: ['Parse', 'Check', 'Plan', 'Run', 'Report'].map((label) => ({ label })),
    edges: [
      { source: 'parse', target: 'check' },
      { source: 'check', target: 'plan' },
      { source: 'plan', target: 'run' },
      { source: 'run', target: 'report' },
    ],
  });
  assert.deepEqual(checkLayout(g), []);
});
