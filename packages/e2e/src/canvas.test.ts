import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  API,
  dragMouse,
  fixtures,
  nodeCentre,
  openCanvas,
  settleViewport,
  startStack,
  until,
  type Stack,
} from './harness.js';

/**
 * Nodes and edges on the main canvas: dragging, connecting, selecting, deleting, and the
 * diagram switcher above it.
 *
 * See `packages/e2e/README.md` for why this whole layer exists and what it holds itself to.
 */

let stack: Stack;

before(async () => {
  stack = await startStack();
}, { timeout: 120_000 });

after(async () => {
  await stack?.stop();
});

const { seed, freshDiagram, nodeById } = fixtures(() => stack);

test('a node drag persists to the server, snapped to the grid', async () => {
  const id = await seed('Draggable', 0, 0);
  await openCanvas(stack, 1);

  const from = await nodeCentre(stack.page, id);
  await dragMouse(stack.page, from, { x: from.x + 220, y: from.y + 130 });

  const moved = await until('the drag to reach the server', async () => {
    const node = await nodeById(id);
    return node.position.x !== 0 || node.position.y !== 0 ? node : null;
  });

  assert.equal(moved.position.x % 15, 0, `x=${moved.position.x} is off-grid`);
  assert.equal(moved.position.y % 15, 0, `y=${moved.position.y} is off-grid`);
  assert.ok(moved.position.x > 100, `expected a rightward move, got ${moved.position.x}`);
});

// The regression guard for the bug where only the node under the cursor was persisted.
test('a multi-node drag persists every selected node, not just one', async () => {
  const a = await seed('Multi A', 0, 400);
  const b = await seed('Multi B', 0, 550);
  const c = await seed('Multi C', 0, 700);
  await openCanvas(stack, 4);

  // Shift-drag a rubber band around the three, which is how a human selects them.
  const boxes = await Promise.all(
    [a, b, c].map((id) => stack.page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox()),
  );
  const minX = Math.min(...boxes.map((box) => box!.x));
  const minY = Math.min(...boxes.map((box) => box!.y));
  const maxX = Math.max(...boxes.map((box) => box!.x + box!.width));
  const maxY = Math.max(...boxes.map((box) => box!.y + box!.height));

  await dragMouse(
    stack.page,
    { x: minX - 25, y: minY - 25 },
    { x: maxX + 25, y: maxY + 25 },
    'Shift',
  );
  await until(
    'three nodes to be selected',
    async () => (await stack.page.locator('.react-flow__node.selected').count()) === 3,
  );

  const before = Object.fromEntries(
    (await Promise.all([a, b, c].map(nodeById))).map((n: any) => [n.id, { ...n.position }]),
  );

  const grip = await nodeCentre(stack.page, b);
  await dragMouse(stack.page, grip, { x: grip.x + 195, y: grip.y + 60 });

  const after = await until('all three moves to reach the server', async () => {
    const nodes = await Promise.all([a, b, c].map(nodeById));
    const allMoved = nodes.every(
      (n: any) => n.position.x !== before[n.id].x || n.position.y !== before[n.id].y,
    );
    return allMoved ? nodes : null;
  });

  for (const node of after as any[]) {
    assert.notDeepEqual(
      node.position,
      before[node.id],
      `${node.id} did not move — only the dragged node was persisted`,
    );
  }
});

test('connecting two nodes creates an edge with the server-assigned id', async () => {
  const src = await seed('Source', 500, 0);
  const dst = await seed('Target', 500, 200);
  await openCanvas(stack);
  await until('both nodes to render', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${dst}"]`).count()) > 0,
  );

  const source = await stack.page
    .locator(`.react-flow__node[data-id="${src}"] .react-flow__handle.source`)
    .boundingBox();
  const target = await stack.page
    .locator(`.react-flow__node[data-id="${dst}"] .react-flow__handle.target`)
    .boundingBox();
  assert.ok(source && target, 'both handles must be present to drag a connection');

  await dragMouse(
    stack.page,
    { x: source.x + source.width / 2, y: source.y + source.height / 2 },
    { x: target.x + target.width / 2, y: target.y + target.height / 2 },
  );

  const edge = await until('the new edge to reach the server', async () => {
    const graph = await stack.graph();
    return graph.edges.find((e: any) => e.source === src && e.target === dst) ?? null;
  });
  assert.equal(edge.id, `${src}->${dst}`, 'the server assigns the id, not the canvas');
});

test('an edge can be clicked and becomes selected', async () => {
  await openCanvas(stack);
  const edge = await until('an edge to render', async () =>
    (await stack.page.locator('.react-flow__edge').count()) > 0,
  );
  assert.ok(edge);

  await stack.page.locator('.react-flow__edge .react-flow__edge-path').first().click({ force: true });

  await until(
    'the edge to report itself selected',
    async () => (await stack.page.locator('.react-flow__edge.selected').count()) > 0,
  );
});

test('the Delete key removes a selected edge', async () => {
  const src = await seed('Del Src', 900, 0);
  const dst = await seed('Del Dst', 900, 200);
  await stack.op({ op: 'add_edge', source: src, target: dst });
  const edgeId = `${src}->${dst}`;

  await openCanvas(stack);
  const selector = `.react-flow__edge[data-id="${edgeId}"]`;
  await until('the target edge to render', async () =>
    (await stack.page.locator(selector).count()) > 0,
  );

  await stack.page.locator(`${selector} .react-flow__edge-path`).click({ force: true });
  await until(
    'that edge to be selected',
    async () => (await stack.page.locator(`${selector}.selected`).count()) > 0,
  );

  await stack.page.keyboard.press('Delete');

  await until('the edge to be gone from the server', async () => {
    const graph = await stack.graph();
    return graph.edges.every((e: any) => e.id !== edgeId);
  });
});

test('the × button on a selected edge removes it', async () => {
  const src = await seed('X Src', 1200, 0);
  const dst = await seed('X Dst', 1200, 200);
  await stack.op({ op: 'add_edge', source: src, target: dst, label: 'via ×' });
  const edgeId = `${src}->${dst}`;

  await openCanvas(stack);
  const selector = `.react-flow__edge[data-id="${edgeId}"]`;
  await until('the target edge to render', async () =>
    (await stack.page.locator(selector).count()) > 0,
  );

  await stack.page.locator(`${selector} .react-flow__edge-path`).click({ force: true });
  await until('the × to appear', async () =>
    (await stack.page.locator('.edge-delete').count()) > 0,
  );

  await stack.page.locator('.edge-delete').first().click();

  await until('the edge to be gone from the server', async () => {
    const graph = await stack.graph();
    return graph.edges.every((e: any) => e.id !== edgeId);
  });
});

test('reconnecting an edge endpoint moves it and keeps its label', async () => {
  const src = await seed('Re Src', 0, 1000);
  const old = await seed('Re Old', 0, 1200);
  const next = await seed('Re New', 300, 1200);
  await stack.op({ op: 'add_edge', source: src, target: old, label: 'reads' });

  await openCanvas(stack);
  const selector = `.react-flow__edge[data-id="${src}->${old}"]`;
  await until('the edge to render', async () =>
    (await stack.page.locator(selector).count()) > 0,
  );

  // Reconnection is driven by React Flow's own anchor — a transparent circle at the edge
  // end, class `react-flow__edgeupdater-target`. Dragging the *node's* handle instead
  // starts a brand-new connection, which is a different gesture entirely.
  const target = await stack.page
    .locator(`${selector} .react-flow__edgeupdater-target`)
    .boundingBox();
  const landing = await stack.page
    .locator(`.react-flow__node[data-id="${next}"] .react-flow__handle.target`)
    .boundingBox();
  assert.ok(target, 'the edge should expose a target reconnect anchor');
  assert.ok(landing, 'the destination node should expose a target handle');

  await dragMouse(
    stack.page,
    { x: target.x + target.width / 2, y: target.y + target.height / 2 },
    { x: landing.x + landing.width / 2, y: landing.y + landing.height / 2 },
  );

  const moved = await until('the reconnected edge to reach the server', async () => {
    const graph = await stack.graph();
    return graph.edges.find((e: any) => e.source === src && e.target === next) ?? null;
  });
  assert.equal(moved.label, 'reads', 'the label must survive a reconnect');
  const graph = await stack.graph();
  assert.ok(
    graph.edges.every((e: any) => e.target !== old || e.source !== src),
    'the old edge should be moved, not duplicated',
  );
});
test('an agent edit appears on the canvas live, without a reload', async () => {
  await openCanvas(stack);
  const before = await stack.page.locator('.react-flow__node').count();

  await stack.op({ op: 'add_node', label: 'From the agent' });

  await until('the agent-added node to render without a reload', async () => {
    const count = await stack.page.locator('.react-flow__node').count();
    const texts = await stack.page.locator('.react-flow__node').allInnerTexts();
    return count > before && texts.some((t) => t.includes('From the agent'));
  });
});
// Which diagram is active is server state, and hidden state is the cost the switcher was
// added to pay back — so what matters is that it is visible and that using it works.
test('the switcher lists diagrams and switching changes what is on screen', async () => {
  const here = await seed('Only in first', 2200, 200);

  const created = await fetch(`${API}/api/diagrams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'second' }),
  });
  assert.equal(created.status, 200, 'creating a second diagram');

  await openCanvas(stack);
  const switcher = stack.page.locator('.diagram-switcher');
  await until('the switcher to list both diagrams', async () =>
    (await switcher.locator('option').count()) >= 2,
  );

  const names = await switcher.locator('option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(names.includes('second'), `switcher should list the new diagram, got ${names}`);

  // The node from the first diagram must be on screen before we leave it, otherwise its
  // absence afterwards proves nothing.
  await until('the first diagram to be rendered', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${here}"]`).count()) > 0,
  );

  await switcher.selectOption('second');
  await settleViewport(stack.page);

  await until('the canvas to empty out', async () =>
    (await stack.page.locator('.react-flow__node').count()) === 0,
  );
  assert.equal(
    await stack.page.locator(`.react-flow__node[data-id="${here}"]`).count(),
    0,
    'the first diagram’s nodes are gone, not merely hidden',
  );
  assert.equal((await stack.graph()).nodes.length, 0, 'and the server agrees on what is active');

  await switcher.selectOption('graph');
  await settleViewport(stack.page);
  await until('the first diagram to come back', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${here}"]`).count()) > 0,
  );
});
/**
 * The last two `window.prompt` calls, replaced.
 *
 * Naming a diagram moved into the header; naming a subcanvas stopped being asked at all,
 * because the name was already derived from the node's label.
 */

test('the header input creates a diagram, and Escape cancels', async () => {
  await openCanvas(stack);
  const listed = async () =>
    stack.page.locator('.diagram-switcher option').allTextContents();
  const before = (await listed()).length;

  // Escape first: nothing should be created.
  await stack.page.locator('.new-diagram').click();
  const input = stack.page.locator('.cp-diagram-input');
  await until('the header input to appear', async () => (await input.count()) > 0);
  await input.fill('abandoned');
  await stack.page.keyboard.press('Escape');
  await until('the input to close', async () => (await input.count()) === 0);
  assert.equal((await listed()).length, before, 'Escape must not create a diagram');

  await stack.page.locator('.new-diagram').click();
  await until('the header input to reappear', async () => (await input.count()) > 0);
  await input.fill('from-header');
  await stack.page.keyboard.press('Enter');

  await until('the new diagram to be listed and active', async () => {
    const names = await listed();
    const active = await stack.page.locator('.diagram-switcher').inputValue();
    return names.some((n) => n.startsWith('from-header')) && active === 'from-header';
  });
});
/*
 * Deleting a node used to send `delete_edge` for the node's own edges as well as
 * `delete_node`, and the server's cascade had already removed them. It worked only because
 * React Flow happened to call the edge callback first — nothing enforced that, and reversed
 * the second op names an edge that no longer exists and 400s.
 *
 * The observable proof is the feed: one op for one deletion. A canvas with no error surface
 * would show nothing either way.
 */
test('deleting a node sends one op, not a delete_edge its cascade already did', async () => {
  const seedIn = await freshDiagram('node-delete');
  const src = await seedIn('Producer', 0, 0);
  const dst = await seedIn('Consumer', 300, 0);

  const edgeId = `${src}->${dst}`;
  assert.equal(
    (await stack.op({ op: 'add_edge', source: src, target: dst }, 'node-delete')).status,
    200,
  );
  await until('the edge to render', async () =>
    (await stack.page.locator(`.react-flow__edge[data-id="${edgeId}"]`).count()) > 0,
  );

  const before = await stack.graph('node-delete');
  assert.equal(before.edges.length, 1, 'the fixture needs an edge for the cascade to remove');

  const node = stack.page.locator(`.react-flow__node[data-id="${src}"]`);
  await node.click();
  await until('the node to report itself selected', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${src}"].selected`).count()) > 0,
  );
  await stack.page.keyboard.press('Delete');

  const after = await until('the node to be gone from the server', async () => {
    const g = await stack.graph('node-delete');
    return g.nodes.every((n: any) => n.id !== src) ? g : null;
  });
  assert.equal(after.edges.length, 0, 'the cascade took the edge with it');

  // No actor filter: these came from the canvas over the websocket, so they are human, and
  // the seeding ops above went over HTTP and sit before `since`.
  const feed = await (await fetch(`${API}/api/changes?since=${before.rev}`)).json();
  const ops = feed.entries.map((e: any) => e.op.op);
  assert.deepEqual(ops, ['delete_node'], `expected one op, got ${ops.join(', ') || 'none'}`);
});
