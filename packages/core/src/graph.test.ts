import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyOp, GraphError, normalize, structuralView } from './ops.js';
import {
  estimateNodeHeight,
  estimateNodeWidth,
  MAX_NODE_WIDTH,
  MIN_NODE_WIDTH,
  NODE_HEIGHT,
  placeNode,
} from './placement.js';
import { parse, serialize } from './serialize.js';
import { emptyGraph, isLayoutOp, type Graph, type GraphOp } from './types.js';

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

/** Do any two nodes' estimated rectangles intersect? */
function findOverlap(g: Graph): string | null {
  const boxes = g.nodes.map((n) => {
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

test('every added node is placed, and placements never overlap', () => {
  let g = emptyGraph();
  for (let i = 0; i < 25; i++) g = applyOp(g, { op: 'add_node', label: `n${i}` });

  assert.equal(g.nodes.filter((n) => n.position).length, 25);
  assert.equal(findOverlap(g), null);
});

// The regression guard for auto-sizing: uniform short labels would hide a placement
// routine that still assumed one fixed width for every box.
test('placements never overlap when label widths vary wildly', () => {
  const labels = [
    'A',
    'Authentication and authorization gateway for the public API surface',
    'DB',
    'Message broker',
    'x',
    'A really quite long node label that will certainly wrap onto several lines',
    'Cache',
    'Observability, metrics, tracing and structured log aggregation pipeline',
    'Q',
    'Worker',
  ];
  let g = emptyGraph();
  for (const label of labels) g = applyOp(g, { op: 'add_node', label });

  assert.equal(g.nodes.length, labels.length);
  assert.equal(findOverlap(g), null);
});

test('a wide neighbour is cleared rather than overlapped', () => {
  let g = applyOp(emptyGraph(), {
    op: 'add_node',
    label: 'An extremely long label that pushes this node to the maximum width',
  });
  const wide = g.nodes[0];
  g = applyOp(g, { op: 'add_node', label: 'B' });

  const next = g.nodes[1].position!;
  assert.ok(
    next.x >= wide.position!.x + estimateNodeWidth(String(wide.data.label)) ||
      next.y >= wide.position!.y + estimateNodeHeight(String(wide.data.label)),
    'the second node must clear the wide one on at least one axis',
  );
});

test('estimated width respects the min and max clamps', () => {
  assert.equal(estimateNodeWidth(''), MIN_NODE_WIDTH);
  assert.equal(estimateNodeWidth('ok'), MIN_NODE_WIDTH, 'short labels hit the floor');
  assert.equal(estimateNodeWidth('x'.repeat(500)), MAX_NODE_WIDTH, 'long labels hit the cap');

  const medium = estimateNodeWidth('A moderately long node label');
  assert.ok(medium > MIN_NODE_WIDTH && medium < MAX_NODE_WIDTH, `got ${medium}`);
});

test('estimated height grows only once a label wraps', () => {
  assert.equal(estimateNodeHeight('Short'), NODE_HEIGHT);
  assert.ok(estimateNodeHeight('y'.repeat(300)) > NODE_HEIGHT, 'wrapped labels are taller');
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

test('add_node_at drops the node exactly where asked, snapped to the grid', () => {
  const g = applyOp(build(), {
    op: 'add_node_at',
    label: 'Queue',
    position: { x: 342.7, y: 118.2 },
  });
  const queue = g.nodes.find((n) => n.id === 'queue')!;
  assert.deepEqual(queue.position, { x: 345, y: 120 });
  assert.equal(queue.data.label, 'Queue');
});

test('add_node_at derives an id from the label and bumps rev', () => {
  const g = build();
  const next = applyOp(g, {
    op: 'add_node_at',
    label: 'Message Broker',
    position: { x: 0, y: 0 },
  });
  assert.ok(next.nodes.some((n) => n.id === 'message-broker'));
  assert.equal(next.rev, g.rev + 1);
});

test('add_node_at disambiguates against an existing id', () => {
  let g = applyOp(emptyGraph(), { op: 'add_node', label: 'Worker' });
  g = applyOp(g, { op: 'add_node_at', label: 'Worker', position: { x: 300, y: 0 } });
  assert.deepEqual(g.nodes.map((n) => n.id), ['worker', 'worker-2']);
});

test('add_node_at leaves every existing position untouched', () => {
  let g = build();
  g = applyOp(g, { op: 'move_node', id: 'auth-service', position: { x: 600, y: 450 } });
  const before = g.nodes.map((n) => ({ id: n.id, ...n.position! }));

  const next = applyOp(g, {
    op: 'add_node_at',
    label: 'Queue',
    position: { x: 900, y: 900 },
  });

  assert.deepEqual(
    next.nodes.filter((n) => n.id !== 'queue').map((n) => ({ id: n.id, ...n.position! })),
    before,
  );
});

// The invariant the whole MCP surface rests on.
test('creating at a point is a layout op, not a structural one', () => {
  assert.ok(isLayoutOp({ op: 'add_node_at', label: 'X', position: { x: 0, y: 0 } }));
  assert.ok(isLayoutOp({ op: 'move_node', id: 'x', position: { x: 0, y: 0 } }));
  assert.ok(!isLayoutOp({ op: 'add_node', label: 'X' }));
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

test('a colour is stored on the node by name', () => {
  const g = applyOp(build(), { op: 'update_node', id: 'database', color: 'amber' });
  assert.equal(g.nodes.find((n) => n.id === 'database')!.data.color, 'amber');
});

test('a node can be created already coloured', () => {
  const g = applyOp(emptyGraph(), { op: 'add_node', label: 'Broken step', color: 'red' });
  assert.equal(g.nodes[0].data.color, 'red');
});

test('an unknown colour is rejected rather than stored', () => {
  for (const color of ['crimsonish', '#a3221c', '', 'RED']) {
    assert.throws(
      () => applyOp(build(), { op: 'update_node', id: 'database', color: color as never }),
      GraphError,
      `"${color}" should not be accepted`,
    );
  }
});

// An uncoloured node should read as untouched in the file, not carry a sentinel.
test('"none" removes the colour key instead of storing the string', () => {
  let g = applyOp(build(), { op: 'update_node', id: 'database', color: 'green' });
  g = applyOp(g, { op: 'update_node', id: 'database', color: 'none' });

  const data = g.nodes.find((n) => n.id === 'database')!.data;
  assert.equal('color' in data, false, 'the key itself is gone');
  assert.ok(!serialize(g).includes('none'), 'and nothing leaks into the file');
});

test('colour and label do not clobber each other', () => {
  let g = applyOp(build(), { op: 'update_node', id: 'database', color: 'blue' });

  g = applyOp(g, { op: 'update_node', id: 'database', label: 'Postgres' });
  let data = g.nodes.find((n) => n.id === 'database')!.data;
  assert.equal(data.color, 'blue', 'relabelling kept the colour');
  assert.equal(data.label, 'Postgres');

  g = applyOp(g, { op: 'update_node', id: 'database', color: 'violet' });
  data = g.nodes.find((n) => n.id === 'database')!.data;
  assert.equal(data.label, 'Postgres', 'recolouring kept the label');
  assert.equal(data.color, 'violet');
});

test('colouring moves nothing', () => {
  let g = applyOp(build(), { op: 'move_node', id: 'database', position: { x: 600, y: 300 } });
  const before = g.nodes.map((n) => ({ ...n.position! }));

  g = applyOp(g, { op: 'update_node', id: 'database', color: 'amber' });

  assert.deepEqual(g.nodes.map((n) => ({ ...n.position! })), before);
});

test('the agent view carries the colour, since colour is meaning', () => {
  const g = applyOp(build(), { op: 'update_node', id: 'database', color: 'red' });
  const view = structuralView(g);
  assert.deepEqual(view.nodes.find((n) => n.id === 'database'), {
    id: 'database',
    label: 'Database',
    color: 'red',
  });
});

// Colour being filtered as noise would defeat the point of storing it semantically.
test('a colour change is structural, so the layout filter keeps it', () => {
  assert.equal(isLayoutOp({ op: 'update_node', id: 'a', color: 'red' }), false);
});

const withSubcanvas = (): Graph =>
  applyOp(build(), { op: 'update_node', id: 'database', subcanvas: 'database-detail' });

test('a node can reference the diagram holding its detail', () => {
  const g = withSubcanvas();
  assert.equal(g.nodes.find((n) => n.id === 'database')!.data.subcanvas, 'database-detail');
});

test('unlinking removes the key rather than storing a sentinel', () => {
  const g = applyOp(withSubcanvas(), {
    op: 'update_node',
    id: 'database',
    subcanvas: 'none',
  });
  const data = g.nodes.find((n) => n.id === 'database')!.data;
  assert.equal('subcanvas' in data, false, 'an unlinked node looks untouched in the file');
});

test('linking a subcanvas leaves the label and colour alone, and vice versa', () => {
  let g = applyOp(build(), { op: 'update_node', id: 'database', color: 'amber' });
  g = applyOp(g, { op: 'update_node', id: 'database', subcanvas: 'database-detail' });
  let data = g.nodes.find((n) => n.id === 'database')!.data;
  assert.equal(data.label, 'Database', 'linking did not disturb the label');
  assert.equal(data.color, 'amber', 'nor the colour');

  g = applyOp(g, { op: 'update_node', id: 'database', label: 'Postgres' });
  data = g.nodes.find((n) => n.id === 'database')!.data;
  assert.equal(data.subcanvas, 'database-detail', 'and relabelling did not drop the link');
});

// A reference that silently disappeared would orphan a whole sub-plan invisibly.
test('the reference survives every other structural op', () => {
  let g = withSubcanvas();
  const ops: GraphOp[] = [
    { op: 'add_node', label: 'Queue' },
    { op: 'add_edge', source: 'database', target: 'queue' },
    { op: 'update_node', id: 'database', color: 'green' },
    { op: 'update_edge', id: 'auth-service->database', label: 'reads' },
    { op: 'align', ids: ['auth-service', 'database'], edge: 'left' },
    { op: 'move_node', id: 'database', position: { x: 300, y: 300 } },
    { op: 'delete_node', id: 'queue' },
  ];

  for (const op of ops) {
    g = applyOp(g, op);
    assert.equal(
      g.nodes.find((n) => n.id === 'database')!.data.subcanvas,
      'database-detail',
      `${op.op} dropped the subcanvas reference`,
    );
  }
});

// The user's decision: deleting a box must not destroy an hour of sub-planning. The graph
// model simply has no power to delete another diagram, and this pins that down.
test('deleting the node removes only the node, never the referenced diagram', () => {
  const g = applyOp(withSubcanvas(), { op: 'delete_node', id: 'database' });
  assert.equal(g.nodes.some((n) => n.id === 'database'), false);
  assert.equal(
    JSON.stringify(g).includes('database-detail'),
    false,
    'the reference goes with the node, but nothing in the graph can reach the other file',
  );
});

test('the agent view shows which nodes have detail behind them', () => {
  const view = structuralView(withSubcanvas());
  assert.deepEqual(view.nodes.find((n) => n.id === 'database'), {
    id: 'database',
    label: 'Database',
    subcanvas: 'database-detail',
  });
});

test('linking a subcanvas is structural, so the layout filter keeps it', () => {
  assert.equal(isLayoutOp({ op: 'update_node', id: 'a', subcanvas: 'detail' }), false);
});

/**
 * Edge colour. Flat on the edge rather than in a data bag, sharing the node palette so one
 * name means one thing across the diagram.
 */

const EDGE = 'auth-service->database';

test('a colour is stored on the edge by name', () => {
  const g = applyOp(build(), { op: 'update_edge', id: EDGE, color: 'amber' });
  assert.equal(g.edges[0].color, 'amber');
});

test('an edge can be created already coloured', () => {
  let g = applyOp(emptyGraph(), { op: 'add_node', label: 'A' });
  g = applyOp(g, { op: 'add_node', label: 'B' });
  g = applyOp(g, { op: 'add_edge', source: 'a', target: 'b', color: 'red' });
  assert.equal(g.edges[0].color, 'red');
});

test('an unknown edge colour is rejected rather than stored', () => {
  for (const color of ['crimsonish', '#a3221c', '', 'RED']) {
    assert.throws(
      () => applyOp(build(), { op: 'update_edge', id: EDGE, color: color as never }),
      GraphError,
      `"${color}" should not be accepted`,
    );
  }
});

test('"none" removes the edge colour key instead of storing the string', () => {
  let g = applyOp(build(), { op: 'update_edge', id: EDGE, color: 'green' });
  g = applyOp(g, { op: 'update_edge', id: EDGE, color: 'none' });
  assert.equal(g.edges[0].color, undefined);
  assert.equal('color' in g.edges[0], false, 'the key itself is gone');
});

test('edge colour and label do not clobber each other', () => {
  let g = applyOp(build(), { op: 'update_edge', id: EDGE, color: 'blue' });
  g = applyOp(g, { op: 'update_edge', id: EDGE, label: 'reads' });
  assert.equal(g.edges[0].color, 'blue', 'relabelling kept the colour');
  assert.equal(g.edges[0].label, 'reads');

  g = applyOp(g, { op: 'update_edge', id: EDGE, color: 'violet' });
  assert.equal(g.edges[0].label, 'reads', 'recolouring kept the label');
  assert.equal(g.edges[0].color, 'violet');
});

// Pointing an arrow somewhere else is not a reason to lose what it meant.
test('reconnecting an edge keeps its colour', () => {
  let g = applyOp(build(), { op: 'add_node', label: 'Cache' });
  g = applyOp(g, { op: 'update_edge', id: EDGE, color: 'red' });
  g = applyOp(g, {
    op: 'reconnect_edge',
    id: EDGE,
    source: 'auth-service',
    target: 'cache',
  });
  assert.equal(g.edges[0].id, 'auth-service->cache');
  assert.equal(g.edges[0].color, 'red');
});

test('colouring an edge moves nothing', () => {
  let g = applyOp(build(), { op: 'move_node', id: 'database', position: { x: 600, y: 300 } });
  const before = g.nodes.map((n) => ({ ...n.position! }));
  g = applyOp(g, { op: 'update_edge', id: EDGE, color: 'amber' });
  assert.deepEqual(g.nodes.map((n) => ({ ...n.position! })), before);
});

test('generate_graph carries edge colours through', () => {
  const g = applyOp(emptyGraph(), {
    op: 'generate_graph',
    nodes: [{ label: 'Try' }, { label: 'Fail' }],
    edges: [{ source: 'try', target: 'fail', label: 'on error', color: 'red' }],
  });
  assert.equal(g.edges[0].color, 'red');
  assert.equal(g.edges[0].label, 'on error');
});

test('generate_graph rejects an invented edge colour', () => {
  assert.throws(
    () =>
      applyOp(emptyGraph(), {
        op: 'generate_graph',
        nodes: [{ label: 'A' }, { label: 'B' }],
        edges: [{ source: 'a', target: 'b', color: 'puce' as never }],
      }),
    GraphError,
  );
});

test('an edge colour reaches the agent view and survives serialisation', () => {
  const g = applyOp(build(), { op: 'update_edge', id: EDGE, color: 'green' });
  assert.equal((structuralView(g).edges[0] as { color?: string }).color, 'green');

  const round = normalize(parse(serialize(g)));
  assert.equal(round.edges[0].color, 'green', 'colour survives a save and load');
});
