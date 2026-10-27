import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeOp, kindOf } from './changes.js';
import { applyOp, GraphError } from './ops.js';
import { KIND_EXTRA, nodeSize } from './placement.js';
import { emptyGraph, NODE_KINDS, type GraphNode, type GraphOp } from './types.js';

const one = () => applyOp(emptyGraph(), { op: 'add_node_at', label: 'Store', position: { x: 0, y: 0 } });

test('a node takes a kind by name, and "none" clears it', () => {
  let g = one();
  const set: GraphOp = { op: 'update_node', id: 'store', kind: 'database' };
  g = applyOp(g, set);
  assert.equal(g.nodes[0].data.kind, 'database');
  assert.match(describeOp(set), /drawn as database/);
  assert.equal(kindOf(set), 'structural');
  const clear: GraphOp = { op: 'update_node', id: 'store', kind: 'none' };
  g = applyOp(g, clear);
  assert.ok(!('kind' in g.nodes[0].data));
  assert.match(describeOp(clear), /kind cleared/);
});

test('an unknown kind is refused at the door', () => {
  assert.throws(() => applyOp(one(), { op: 'update_node', id: 'store', kind: 'cloud' as 'note' }), /Unknown kind "cloud"/);
  assert.throws(() => applyOp(emptyGraph(), { op: 'add_node', label: 'X', kind: 'blob' as 'note' }), GraphError);
  assert.throws(
    () => applyOp(emptyGraph(), { op: 'generate_graph', nodes: [{ label: 'X', kind: 'blob' as 'note' }], edges: [] }),
    GraphError,
  );
});

test('add_node and generate_graph carry a kind', () => {
  const added = applyOp(emptyGraph(), { op: 'add_node', label: 'Jobs', kind: 'queue' });
  assert.equal(added.nodes[0].data.kind, 'queue');
  const generated = applyOp(emptyGraph(), {
    op: 'generate_graph',
    nodes: [{ label: 'User', kind: 'actor' }, { label: 'Ok?', kind: 'decision' }],
    edges: [{ source: 'user', target: 'ok' }],
  });
  assert.deepEqual(generated.nodes.map((n) => n.data.kind), ['actor', 'decision']);
});

test('a kind that needs room is measured bigger, so placement agrees with the canvas', () => {
  const plain: GraphNode = { id: 'a', position: { x: 0, y: 0 }, data: { label: 'Something' } };
  for (const kind of NODE_KINDS) {
    const sized = nodeSize({ ...plain, data: { ...plain.data, kind } });
    const extra = KIND_EXTRA[kind] ?? { w: 0, h: 0 };
    assert.deepEqual(sized, { w: nodeSize(plain).w + extra.w, h: nodeSize(plain).h + extra.h }, kind);
  }
  assert.ok(KIND_EXTRA.decision!.w > 0 && KIND_EXTRA.database!.h > 0);
});
