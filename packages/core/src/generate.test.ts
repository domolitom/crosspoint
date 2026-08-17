import assert from 'node:assert/strict';
import { test } from 'node:test';

import { kindOf, withoutLayout, type LogEntry } from './changes.js';
import { applyOp, GraphError } from './ops.js';
import { estimateNodeHeight, estimateNodeWidth, GRID } from './placement.js';
import { emptyGraph, type Graph, type GeneratedEdge, type GeneratedNode } from './types.js';

const generate = (
  graph: Graph,
  nodes: GeneratedNode[],
  edges: GeneratedEdge[] = [],
  replace = false,
) => applyOp(graph, { op: 'generate_graph', nodes, edges, replace });

const labels = (...names: string[]) => names.map((label) => ({ label }));

/** Do any two nodes' estimated rectangles intersect? */
function findOverlap(graph: Graph): string | null {
  const boxes = graph.nodes.map((n) => {
    const label = String(n.data.label);
    return {
      id: n.id,
      x: n.position!.x,
      y: n.position!.y,
      w: estimateNodeWidth(label),
      h: estimateNodeHeight(label),
    };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        return `${a.id} overlaps ${b.id}`;
      }
    }
  }
  return null;
}

test('a generated graph places every node and identifies every edge', () => {
  const g = generate(emptyGraph(), labels('Start', 'Validate', 'Done'), [
    { source: 'start', target: 'validate' },
    { source: 'validate', target: 'done' },
  ]);

  assert.deepEqual(g.nodes.map((n) => n.id), ['start', 'validate', 'done']);
  assert.ok(g.nodes.every((n) => n.position), 'every node is placed');
  assert.deepEqual(g.edges.map((e) => e.id), ['start->validate', 'validate->done']);
});

test('ids default from labels but an explicit one wins', () => {
  const g = generate(emptyGraph(), [
    { label: 'Parse input' },
    { label: 'Parse input', id: 'parse-again' },
  ]);
  assert.deepEqual(g.nodes.map((n) => n.id), ['parse-input', 'parse-again']);
});

test('edges connect the intended nodes after id resolution', () => {
  const g = generate(
    emptyGraph(),
    [
      { label: 'Fetch', id: 'a' },
      { label: 'Cache', id: 'b' },
      { label: 'Store', id: 'c' },
    ],
    [
      { source: 'a', target: 'c', label: 'writes' },
      { source: 'b', target: 'c' },
    ],
  );

  const writes = g.edges.find((e) => e.label === 'writes')!;
  assert.equal(writes.source, 'a');
  assert.equal(writes.target, 'c');
  assert.equal(g.edges.length, 2);
});

// The hierarchy is the reason for using a layout engine at all; positions merely
// existing would pass a weaker assertion while the graph still read as a staircase.
test('sources rank above their targets', () => {
  const g = generate(
    emptyGraph(),
    labels('Start', 'Branch A', 'Branch B', 'Join'),
    [
      { source: 'start', target: 'branch-a' },
      { source: 'start', target: 'branch-b' },
      { source: 'branch-a', target: 'join' },
      { source: 'branch-b', target: 'join' },
    ],
  );

  const y = (id: string) => g.nodes.find((n) => n.id === id)!.position!.y;
  assert.ok(y('start') < y('branch-a'), 'start above branch-a');
  assert.ok(y('start') < y('branch-b'), 'start above branch-b');
  assert.ok(y('branch-a') < y('join'), 'branch-a above join');
  assert.equal(y('branch-a'), y('branch-b'), 'siblings share a rank');
});

test('generated nodes never overlap, even with wildly different label widths', () => {
  const g = generate(
    emptyGraph(),
    [
      { label: 'A' },
      { label: 'Authentication and authorization gateway for the public API surface' },
      { label: 'DB' },
      { label: 'Observability, metrics, tracing and structured log aggregation pipeline' },
      { label: 'Q' },
      { label: 'A really quite long node label that will certainly wrap onto several lines' },
      { label: 'Worker' },
    ],
    [
      { source: 'a', target: 'db' },
      { source: 'q', target: 'worker' },
    ],
  );

  assert.equal(g.nodes.length, 7);
  assert.equal(findOverlap(g), null);
});

// Dagre reports centres; this model stores top-left corners. Without the conversion a
// root node lands half a box off, and every overlap check is quietly wrong.
test('positions are top-left corners, not centres', () => {
  const wide = 'An extremely long label that reaches the maximum node width';
  const g = generate(
    emptyGraph(),
    [
      { label: wide, id: 'wide' },
      { label: 'B', id: 'narrow' },
    ],
    [{ source: 'wide', target: 'narrow' }],
  );

  const root = g.nodes[0].position!;
  const width = estimateNodeWidth(wide);
  const child = g.nodes[1].position!;
  const childWidth = estimateNodeWidth('B');

  // With a single child, dagre centres both on the same axis. Corner coordinates make
  // their *centres* line up; centre coordinates would make their corners line up.
  assert.ok(
    Math.abs((root.x + width / 2) - (child.x + childWidth / 2)) <= GRID,
    `centres should align: root ${root.x}+${width / 2}, child ${child.x}+${childWidth / 2}`,
  );
  assert.notEqual(root.x, child.x, 'corners of differently sized boxes must not coincide');
});

test('positions land on the grid', () => {
  const g = generate(emptyGraph(), labels('One', 'Two', 'Three'), [
    { source: 'one', target: 'two' },
    { source: 'two', target: 'three' },
  ]);

  for (const node of g.nodes) {
    assert.equal(node.position!.x % GRID, 0, `${node.id} x off-grid: ${node.position!.x}`);
    assert.equal(node.position!.y % GRID, 0, `${node.id} y off-grid: ${node.position!.y}`);
  }
});

test('the whole graph costs exactly one rev', () => {
  const before = emptyGraph();
  const g = generate(before, labels('A', 'B', 'C', 'D', 'E'), [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ]);
  assert.equal(g.rev, before.rev + 1);
});

test('a non-empty diagram is refused, and the message says how much is at stake', () => {
  const existing = generate(emptyGraph(), labels('Keep', 'This'));

  assert.throws(
    () => generate(existing, labels('New')),
    (err: Error) => {
      assert.ok(err instanceof GraphError);
      assert.match(err.message, /has 2 nodes/);
      assert.match(err.message, /replace: true/);
      return true;
    },
  );
});

test('a refusal does not partially apply', () => {
  const existing = generate(emptyGraph(), labels('Keep', 'This'), [
    { source: 'keep', target: 'this' },
  ]);
  const snapshot = JSON.stringify(existing);

  assert.throws(() => generate(existing, labels('New')), GraphError);
  assert.equal(JSON.stringify(existing), snapshot, 'the original graph is untouched');
});

test('replace: true discards the previous diagram wholesale', () => {
  const existing = generate(emptyGraph(), labels('Old One', 'Old Two'), [
    { source: 'old-one', target: 'old-two' },
  ]);
  const replaced = generate(existing, labels('Fresh'), [], true);

  assert.deepEqual(replaced.nodes.map((n) => n.id), ['fresh']);
  assert.deepEqual(replaced.edges, []);
  assert.equal(replaced.rev, existing.rev + 1, 'still one rev');
});

// Uniquifying here would silently wire edges to the wrong node, unlike in add_node.
test('duplicate ids in one payload are refused rather than uniquified', () => {
  assert.throws(
    () => generate(emptyGraph(), [{ label: 'Validate' }, { label: 'Validate' }]),
    (err: Error) => {
      assert.ok(err instanceof GraphError);
      assert.match(err.message, /Duplicate node id "validate"/);
      assert.match(err.message, /explicit id/);
      return true;
    },
  );
});

test('an edge naming an unknown node is refused', () => {
  assert.throws(
    () => generate(emptyGraph(), labels('A'), [{ source: 'a', target: 'ghost' }]),
    (err: Error) => {
      assert.match(err.message, /Edge target "ghost"/);
      return true;
    },
  );
  assert.throws(
    () => generate(emptyGraph(), labels('A'), [{ source: 'ghost', target: 'a' }]),
    /Edge source "ghost"/,
  );
});

test('generated nodes carry their colour, and an unknown colour is refused', () => {
  const g = generate(emptyGraph(), [
    { label: 'Broken', color: 'red' },
    { label: 'Fine' },
  ]);
  assert.equal(g.nodes[0].data.color, 'red');
  assert.ok(!('color' in g.nodes[1].data), 'an uncoloured node carries no colour key');

  assert.throws(
    () => generate(emptyGraph(), [{ label: 'X', color: 'chartreuse' as never }]),
    GraphError,
  );
});

// Colour aside, generation is structural: the issuer supplied no coordinates.
test('generate_graph is structural, so the change feed keeps it', () => {
  const op = { op: 'generate_graph' as const, nodes: labels('A'), edges: [] };
  assert.equal(kindOf(op), 'structural');

  const feed: LogEntry[] = [
    { rev: 1, ts: 'x', kind: kindOf(op), diagram: 'plan', op },
    {
      rev: 2,
      ts: 'x',
      kind: 'layout',
      diagram: 'plan',
      op: { op: 'move_node', id: 'a', position: { x: 0, y: 0 } },
    },
  ];
  assert.deepEqual(withoutLayout(feed).map((e) => e.rev), [1]);
});

test('a control-flow-shaped 40-node graph lays out cleanly and quickly', () => {
  const nodes: GeneratedNode[] = [{ label: 'entry' }];
  const edges: GeneratedEdge[] = [];
  // A spine with branches rejoining it — roughly the shape of a real CFG.
  for (let i = 1; i < 40; i++) {
    nodes.push({ label: `step ${i}` });
    edges.push({ source: i === 1 ? 'entry' : `step-${i - 1}`, target: `step-${i}` });
    if (i % 5 === 0 && i > 5) {
      edges.push({ source: `step-${i - 4}`, target: `step-${i}` });
    }
  }

  const started = process.hrtime.bigint();
  const g = generate(emptyGraph(), nodes, edges);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(g.nodes.length, 40);
  assert.equal(findOverlap(g), null, 'a real-sized graph must not overlap');
  assert.ok(ms < 2000, `layout took ${ms.toFixed(0)}ms`);
});
