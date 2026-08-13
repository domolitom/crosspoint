import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyOp, GraphError, normalize, structuralView } from './ops.js';
import { NODE_HEIGHT, NODE_WIDTH, placeNode } from './placement.js';
import { parse, serialize } from './serialize.js';
import { emptyGraph, type Graph } from './types.js';

const build = (): Graph => {
  let g = emptyGraph();
  g = applyOp(g, { op: 'add_node', label: 'Auth service' });
  g = applyOp(g, { op: 'add_node', label: 'Database' });
  return applyOp(g, { op: 'add_edge', source: 'auth-service', target: 'database' });
};

test('ids are derived from labels so they carry meaning', () => {
  const g = build();
  assert.deepEqual(g.nodes.map((n) => n.id), ['auth-service', 'database']);
  assert.equal(g.edges[0].id, 'auth-service->database');
});

test('duplicate labels get distinct ids', () => {
  let g = applyOp(emptyGraph(), { op: 'add_node', label: 'Worker' });
  g = applyOp(g, { op: 'add_node', label: 'Worker' });
  assert.deepEqual(g.nodes.map((n) => n.id), ['worker', 'worker-2']);
});

test('every added node is placed, and placements never overlap', () => {
  let g = emptyGraph();
  for (let i = 0; i < 25; i++) g = applyOp(g, { op: 'add_node', label: `n${i}` });

  const positions = g.nodes.map((n) => n.position!);
  assert.equal(positions.filter(Boolean).length, 25);

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const overlapping =
        Math.abs(positions[i].x - positions[j].x) < NODE_WIDTH &&
        Math.abs(positions[i].y - positions[j].y) < NODE_HEIGHT;
      assert.ok(!overlapping, `nodes ${i} and ${j} overlap`);
    }
  }
});

test('placement honours the `near` hint by going below the anchor', () => {
  const g = build();
  const next = applyOp(g, { op: 'add_node', label: 'Cache', near: 'auth-service' });
  const auth = g.nodes.find((n) => n.id === 'auth-service')!.position!;
  const cache = next.nodes.find((n) => n.id === 'cache')!.position!;
  assert.equal(cache.x, auth.x);
  assert.ok(cache.y > auth.y, 'cache should sit below its anchor');
});

// The core guarantee: an agent restructuring the graph cannot move what a human placed.
test('structural ops leave every existing position untouched', () => {
  let g = build();
  g = applyOp(g, { op: 'move_node', id: 'auth-service', position: { x: 600, y: 450 } });
  const pinned = g.nodes.find((n) => n.id === 'auth-service')!.position!;

  const ops = [
    { op: 'add_node', label: 'Queue' },
    { op: 'update_node', id: 'database', label: 'Postgres' },
    { op: 'add_edge', source: 'database', target: 'auth-service' },
    { op: 'delete_edge', id: 'auth-service->database' },
  ] as const;

  for (const op of ops) {
    g = applyOp(g, op);
    const after = g.nodes.find((n) => n.id === 'auth-service')!.position!;
    assert.deepEqual(after, pinned, `${op.op} disturbed a pinned position`);
  }
});

test('a drag lands on the grid', () => {
  const g = applyOp(build(), {
    op: 'move_node',
    id: 'database',
    position: { x: 342.7, y: 118.2 },
  });
  assert.deepEqual(g.nodes.find((n) => n.id === 'database')!.position, { x: 345, y: 120 });
});

test('reconnecting an edge regenerates its id and keeps its label', () => {
  let g = build();
  g = applyOp(g, { op: 'add_node', label: 'Cache' });
  g = applyOp(g, { op: 'update_edge', id: 'auth-service->database', label: 'reads' });

  const next = applyOp(g, {
    op: 'reconnect_edge',
    id: 'auth-service->database',
    source: 'auth-service',
    target: 'cache',
  });

  assert.equal(next.edges.length, 1);
  assert.equal(next.edges[0].id, 'auth-service->cache', 'id follows the new endpoints');
  assert.equal(next.edges[0].target, 'cache');
  assert.equal(next.edges[0].label, 'reads', 'label survives the move');
});

test('a reconnected edge stays at the same index, so the diff stays small', () => {
  let g = emptyGraph();
  for (const label of ['A', 'B', 'C']) g = applyOp(g, { op: 'add_node', label });
  g = applyOp(g, { op: 'add_edge', source: 'a', target: 'b' });
  g = applyOp(g, { op: 'add_edge', source: 'b', target: 'c' });
  g = applyOp(g, { op: 'add_edge', source: 'c', target: 'a' });

  const next = applyOp(g, { op: 'reconnect_edge', id: 'b->c', source: 'b', target: 'a' });

  assert.deepEqual(next.edges.map((e) => e.id), ['a->b', 'b->a', 'c->a']);
});

test('reconnecting does not move any node', () => {
  let g = build();
  g = applyOp(g, { op: 'add_node', label: 'Cache' });
  g = applyOp(g, { op: 'move_node', id: 'database', position: { x: 600, y: 300 } });
  const before = g.nodes.map((n) => ({ ...n.position! }));

  const next = applyOp(g, {
    op: 'reconnect_edge',
    id: 'auth-service->database',
    source: 'auth-service',
    target: 'cache',
  });

  assert.deepEqual(next.nodes.map((n) => ({ ...n.position! })), before);
});

test('reconnecting bumps rev', () => {
  const g = build();
  const next = applyOp(g, {
    op: 'reconnect_edge',
    id: 'auth-service->database',
    source: 'database',
    target: 'auth-service',
  });
  assert.equal(next.rev, g.rev + 1);
});

test('reconnecting rejects unknown edge and node ids', () => {
  const g = build();
  assert.throws(
    () =>
      applyOp(g, {
        op: 'reconnect_edge',
        id: 'ghost->database',
        source: 'auth-service',
        target: 'database',
      }),
    GraphError,
  );
  assert.throws(
    () =>
      applyOp(g, {
        op: 'reconnect_edge',
        id: 'auth-service->database',
        source: 'auth-service',
        target: 'ghost',
      }),
    GraphError,
  );
});

test('deleting a node cascades to its edges', () => {
  const g = applyOp(build(), { op: 'delete_node', id: 'database' });
  assert.equal(g.edges.length, 0);
});

test('edges to unknown nodes are rejected', () => {
  assert.throws(
    () => applyOp(build(), { op: 'add_edge', source: 'auth-service', target: 'ghost' }),
    GraphError,
  );
});

test('every applied op bumps rev', () => {
  const g = build();
  assert.equal(g.rev, 3);
});

test('normalize places hand-written nodes that omit a position', () => {
  const g = normalize({
    rev: 0,
    nodes: [
      { id: 'a', data: { label: 'A' } },
      { id: 'b', position: { x: 400, y: 0 }, data: { label: 'B' } },
    ],
    edges: [{ id: 'a->ghost', source: 'a', target: 'ghost' }],
  });

  assert.ok(g.nodes[0].position, 'unpositioned node should be seeded');
  assert.deepEqual(g.nodes[1].position, { x: 400, y: 0 }, 'existing position preserved');
  assert.equal(g.edges.length, 0, 'dangling edge dropped');
});

test('the agent view omits coordinates', () => {
  const view = structuralView(build());
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('position'), 'structural view must not leak geometry');
  assert.deepEqual(view.nodes[0], { id: 'auth-service', label: 'Auth service' });
});

test('serialisation round-trips and is stable', () => {
  const g = build();
  const once = serialize(g);
  assert.equal(serialize(normalize(parse(once))), once);
});

test('serialisation key order is fixed regardless of insertion order', () => {
  const text = serialize({
    rev: 1,
    nodes: [{ id: 'n', position: { x: 0, y: 0 }, data: { zebra: 1, label: 'N', alpha: 2 } }],
    edges: [],
  });
  const keys = text.slice(text.indexOf('"data"')).match(/"(label|alpha|zebra)"/g);
  assert.deepEqual(keys, ['"label"', '"alpha"', '"zebra"']);
});

test('placeNode on an empty graph starts at the origin', () => {
  assert.deepEqual(placeNode([]), { x: 0, y: 0 });
});
