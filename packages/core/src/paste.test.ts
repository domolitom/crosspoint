import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeOp, kindOf, withoutLayout, type LogEntry } from './changes.js';
import { copySelection, pasteOp } from './clipboard.js';
import { applyOp, GraphError } from './ops.js';
import { emptyGraph, isLayoutOp, type Graph, type GraphOp } from './types.js';

const build = (): Graph => {
  let g = emptyGraph();
  g = applyOp(g, { op: 'add_node_at', label: 'Auth', position: { x: 0, y: 0 } });
  g = applyOp(g, { op: 'add_node_at', label: 'Db', position: { x: 300, y: 0 } });
  g = applyOp(g, { op: 'add_node_at', label: 'Cache', position: { x: 0, y: 300 } });
  g = applyOp(g, {
    op: 'update_node',
    id: 'auth',
    body: 'line one\nline two',
    color: 'amber',
    code: { file: 'src/auth.ts', lines: '1-9' },
    subcanvas: 'auth-detail',
  });
  g = applyOp(g, { op: 'resize_node', id: 'auth', size: { w: 450, h: 120 } });
  g = applyOp(g, { op: 'add_edge', source: 'auth', target: 'db', label: 'reads', color: 'red', arrow: 'both' });
  g = applyOp(g, { op: 'attach_edge', id: 'auth->db', source: 'bottom', target: 'top' });
  return applyOp(g, { op: 'add_edge', source: 'auth', target: 'cache' });
};

const paste = (g: Graph, ids: string[], dx = 30, dy = 30) => applyOp(g, pasteOp(copySelection(g, ids)!, dx, dy));

test('a pasted node gets a new id and keeps everything it carried', () => {
  const g = build();
  const next = paste(g, ['auth']);
  const copy = next.nodes.find((n) => n.id === 'auth-2')!;
  const original = g.nodes.find((n) => n.id === 'auth')!;
  assert.deepEqual(copy.data, original.data, 'label, body, colour, code and subcanvas link');
  assert.deepEqual(copy.size, original.size);
  assert.deepEqual(copy.position, { x: original.position!.x + 30, y: original.position!.y + 30 });
  assert.equal(next.rev, g.rev + 1, 'one op, one rev');
});

test('edges between copied nodes are rewired to the copies, edges leaving the selection are not copied', () => {
  const g = build();
  const clip = copySelection(g, ['auth', 'db'])!;
  assert.deepEqual(
    clip.edges.map((e) => `${e.source}->${e.target}`),
    ['auth->db'],
    'auth->cache leaves the selection',
  );

  const next = paste(g, ['auth', 'db']);
  const added = next.edges.slice(g.edges.length);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], {
    id: 'auth-2->db-2',
    source: 'auth-2',
    target: 'db-2',
    label: 'reads',
    color: 'red',
    arrow: 'both',
    sourceSide: 'bottom',
    targetSide: 'top',
  });
  assert.deepEqual(next.edges.slice(0, g.edges.length), g.edges, 'originals untouched');
  assert.deepEqual(next.nodes.slice(0, g.nodes.length), g.nodes);
});

test('pasting twice gives distinct ids again', () => {
  let g = build();
  g = paste(g, ['auth', 'db']);
  g = paste(g, ['auth', 'db'], 60, 60);
  assert.ok(g.nodes.some((n) => n.id === 'auth-3'));
  assert.ok(g.edges.some((e) => e.id === 'auth-3->db-3'));
});

test('two pasted nodes with the same label get distinct ids within one paste', () => {
  const g = applyOp(emptyGraph(), {
    op: 'paste',
    nodes: [
      { ref: 'a', position: { x: 0, y: 0 }, data: { label: 'Worker' } },
      { ref: 'b', position: { x: 300, y: 0 }, data: { label: 'Worker' } },
    ],
    edges: [{ source: 'a', target: 'b' }],
  });
  assert.deepEqual(g.nodes.map((n) => n.id), ['worker', 'worker-2']);
  assert.equal(g.edges[0].id, 'worker->worker-2');
  assert.ok(g.edges[0].sourceSide && g.edges[0].targetSide, 'unpinned ends are seeded');
});

test('paste refuses bad input at the door', () => {
  const g = build();
  const node = { ref: 'x', position: { x: 0, y: 0 }, data: { label: 'X' } };
  const bad: GraphOp[] = [
    { op: 'paste', nodes: [], edges: [] },
    { op: 'paste', nodes: [{ ...node, data: { label: '' } }], edges: [] },
    { op: 'paste', nodes: [{ ...node, data: { label: 'X', color: 'crimsonish' as never } }], edges: [] },
    { op: 'paste', nodes: [{ ...node, data: { label: 'X', code: { file: '' } } }], edges: [] },
    { op: 'paste', nodes: [node, node], edges: [] },
    { op: 'paste', nodes: [node], edges: [{ source: 'x', target: 'auth' }] },
    { op: 'paste', nodes: [node], edges: [{ source: 'x', target: 'x', arrow: 'sideways' as never }] },
    { op: 'paste', nodes: [node], edges: [{ source: 'x', target: 'x', sourceSide: 'middle' as never }] },
  ];
  for (const op of bad) assert.throws(() => applyOp(g, op), GraphError, JSON.stringify(op));
});

test('copying nothing that exists gives no clip', () => {
  assert.equal(copySelection(build(), ['ghost']), null);
});

test('paste is canvas-only but stays in the feed', () => {
  const op = pasteOp(copySelection(build(), ['auth', 'db'])!, 30, 30);
  assert.equal(isLayoutOp(op), true, 'it carries positions, so an agent may not issue it');
  assert.equal(kindOf(op), 'structural', 'but it creates nodes, which is always the message');
  const entry: LogEntry = { rev: 1, ts: 'x', kind: kindOf(op), diagram: 'plan', op };
  assert.equal(withoutLayout([entry]).length, 1);
  assert.equal(describeOp(op), '+ pasted 2 nodes ("Auth", "Db"), 1 edge');
});
