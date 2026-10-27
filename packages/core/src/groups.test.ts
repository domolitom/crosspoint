import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeOp, kindOf } from './changes.js';
import { groupRects } from './groups.js';
import { applyOp, GraphError } from './ops.js';
import { nodeSize } from './placement.js';
import { emptyGraph, type Graph, type GraphOp } from './types.js';

const generated = (): Graph =>
  applyOp(emptyGraph(), {
    op: 'generate_graph',
    nodes: [
      { label: 'Web', group: 'Frontend' },
      { label: 'Mobile', group: 'Frontend' },
      { label: 'Gateway' },
      { label: 'Orders', group: 'Backend' },
      { label: 'Billing', group: 'Backend' },
      { label: 'Users', group: 'Backend' },
      { label: 'Postgres', group: 'Data' },
      { label: 'Redis', group: 'Data' },
    ],
    edges: [
      { source: 'web', target: 'gateway' },
      { source: 'mobile', target: 'gateway' },
      { source: 'gateway', target: 'orders' },
      { source: 'gateway', target: 'billing' },
      { source: 'gateway', target: 'users' },
      { source: 'orders', target: 'postgres' },
      { source: 'billing', target: 'postgres' },
      { source: 'users', target: 'redis' },
    ],
  });

const rects = (g: Graph) =>
  groupRects(g.nodes.map((n) => ({ ...n.position!, ...nodeSize(n), group: n.data.group })));

const meets = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('generated nodes carry their group', () => {
  const g = generated();
  assert.equal(g.nodes.find((n) => n.id === 'orders')!.data.group, 'Backend');
  assert.equal(g.nodes.find((n) => n.id === 'gateway')!.data.group, undefined);
});

test('each group is laid out together: its container holds only its members', () => {
  const g = generated();
  const containers = rects(g);
  assert.deepEqual(containers.map((r) => r.name).sort(), ['Backend', 'Data', 'Frontend']);
  for (const c of containers) {
    for (const n of g.nodes) {
      if (n.data.group === c.name) continue;
      const box = { ...n.position!, ...nodeSize(n) };
      assert.ok(!meets(c, box), `${n.id} sits inside ${c.name}`);
    }
  }
  for (let i = 0; i < containers.length; i++) {
    for (let j = i + 1; j < containers.length; j++) {
      assert.ok(!meets(containers[i], containers[j]), `${containers[i].name} overlaps ${containers[j].name}`);
    }
  }
});

test('a container wraps its members with room for its name', () => {
  const g = generated();
  const backend = rects(g).find((r) => r.name === 'Backend')!;
  for (const n of g.nodes.filter((n) => n.data.group === 'Backend')) {
    const { w, h } = nodeSize(n);
    assert.ok(n.position!.x > backend.x && n.position!.x + w < backend.x + backend.w, n.id);
    assert.ok(n.position!.y > backend.y + 16 && n.position!.y + h < backend.y + backend.h, n.id);
  }
});

test('update_node sets and clears a group, and the feed names it', () => {
  let g = generated();
  const set: GraphOp = { op: 'update_node', id: 'gateway', group: 'Backend' };
  g = applyOp(g, set);
  assert.equal(g.nodes.find((n) => n.id === 'gateway')!.data.group, 'Backend');
  assert.match(describeOp(set), /grouped Backend/);
  assert.equal(kindOf(set), 'structural');
  const clear: GraphOp = { op: 'update_node', id: 'gateway', group: 'none' };
  g = applyOp(g, clear);
  assert.ok(!('group' in g.nodes.find((n) => n.id === 'gateway')!.data));
  assert.match(describeOp(clear), /ungrouped/);
});

test('a group must be a one-line name', () => {
  const g = generated();
  for (const group of ['', '  ', 'two\nlines', 42]) {
    assert.throws(
      () => applyOp(g, { op: 'update_node', id: 'gateway', group: group as string }),
      GraphError,
      JSON.stringify(group),
    );
  }
  assert.throws(
    () => applyOp(emptyGraph(), { op: 'generate_graph', nodes: [{ label: 'A', group: '' }], edges: [] }),
    GraphError,
  );
});

test('add_node into a group lands beside that group, not after the rightmost node', () => {
  let g = generated();
  g = applyOp(g, { op: 'add_node', label: 'Memcached', group: 'Data' });
  const added = g.nodes.find((n) => n.id === 'memcached')!;
  assert.equal(added.data.group, 'Data');
  const data = g.nodes.filter((n) => n.data.group === 'Data' && n.id !== 'memcached');
  const nearest = Math.min(
    ...data.map((n) => Math.hypot(n.position!.x - added.position!.x, n.position!.y - added.position!.y)),
  );
  assert.ok(nearest < 300, `${nearest}px from the nearest Data node`);
  for (const n of g.nodes) {
    if (n.id === 'memcached') continue;
    assert.ok(!meets({ ...added.position!, ...nodeSize(added) }, { ...n.position!, ...nodeSize(n) }), n.id);
  }
});

test('ungrouped nodes produce no containers', () => {
  assert.deepEqual(groupRects([{ x: 0, y: 0, w: 100, h: 40 }]), []);
});

test('siblings listed in alternating groups are still laid out group by group', () => {
  const kids = ['a1', 'b1', 'a2', 'b2', 'a3', 'b3'];
  const g = applyOp(emptyGraph(), {
    op: 'generate_graph',
    nodes: [{ label: 'Root' }, ...kids.map((k) => ({ label: k, group: k[0] === 'a' ? 'A' : 'B' }))],
    edges: kids.map((k) => ({ source: 'root', target: k })),
  });
  const [a, b] = ['A', 'B'].map((name) => rects(g).find((r) => r.name === name)!);
  assert.ok(!meets(a, b), 'A and B containers overlap, so their members interleave');
});
