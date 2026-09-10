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

  // Every handle is a `source` under ConnectionMode.Loose, so a side is named rather than
  // a role: the target sits below, which is the face a person would drag between.
  const source = await stack.page
    .locator(`.react-flow__node[data-id="${src}"] .react-flow__handle-bottom`)
    .boundingBox();
  const target = await stack.page
    .locator(`.react-flow__node[data-id="${dst}"] .react-flow__handle-top`)
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
    .locator(`.react-flow__node[data-id="${next}"] .react-flow__handle-top`)
    .boundingBox();
  assert.ok(target, 'the edge should expose a target reconnect anchor');
  assert.ok(landing, 'the destination node should expose a handle to land on');

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

/** A node's box in flow coordinates, which is the space an edge path is drawn in. */
async function flowRect(id: string) {
  return await stack.page.$eval(`.react-flow__node[data-id="${id}"]`, (el) => {
    const m = /translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\)/.exec((el as HTMLElement).style.transform);
    return {
      x: Number(m?.[1] ?? 0),
      y: Number(m?.[2] ?? 0),
      w: (el as HTMLElement).offsetWidth,
      h: (el as HTMLElement).offsetHeight,
    };
  });
}

/** Where the drawn edge starts — the `M x,y` that opens its path. */
async function pathStart(edgeId: string) {
  const d = await stack.page.getAttribute(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`, 'd');
  const m = /^M\s*([-\d.]+)[, ]\s*([-\d.]+)/.exec(d ?? '');
  assert.ok(m, `could not read the path of ${edgeId}: ${d}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Where it ends — the last coordinate pair of the cubic. */
async function pathEnd(edgeId: string) {
  const d = await stack.page.getAttribute(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`, 'd');
  const m = /([-\d.]+),([-\d.]+)\s*$/.exec(d ?? '');
  assert.ok(m, `could not read the path of ${edgeId}: ${d}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** The four connection points of a node, in flow coordinates. */
function points(box: { x: number; y: number; w: number; h: number }) {
  return {
    top: { x: box.x + box.w / 2, y: box.y },
    right: { x: box.x + box.w, y: box.y + box.h / 2 },
    bottom: { x: box.x + box.w / 2, y: box.y + box.h },
    left: { x: box.x, y: box.y + box.h / 2 },
  };
}

function assertOnPoint(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
  what: string,
) {
  // 3px, not 0: this measures the node with `offsetWidth` while React Flow places its
  // handles from `getBoundingClientRect`, and the 1px border puts them 2px apart. The bug
  // this guards — an end sliding onto a corner — is tens of pixels, so the slack is free.
  assert.ok(
    Math.abs(actual.x - expected.x) < 3 && Math.abs(actual.y - expected.y) < 3,
    `${what}: expected the connection point at (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`,
  );
}

/*
 * The side an edge uses is computed, never stored — so it has to follow the arrangement.
 * A neighbour to the right must be reached across the right face, not looped from the
 * bottom, and the same pair placed vertically must use the bottom face instead.
 */
test('an edge leaves through the face pointing at the other node', async () => {
  const seedIn = await freshDiagram('sides');
  const a = await seedIn('Side A', 0, 0);
  const b = await seedIn('Side B', 400, 0);
  await stack.op({ op: 'add_edge', source: a, target: b }, 'sides');

  await until('the edge to render', async () =>
    (await stack.page.locator(`.react-flow__edge[data-id="${a}->${b}"]`).count()) > 0,
  );

  assertOnPoint(await pathStart(`${a}->${b}`), points(await flowRect(a)).right, 'source end');
  assertOnPoint(await pathEnd(`${a}->${b}`), points(await flowRect(b)).left, 'target end');
});

/*
 * Where #15 actually showed itself. Separating a reciprocal pair by shifting its ends walked
 * them off the face and onto the corners, and the pair still has to be two readable lines —
 * so assert both: each end exactly on its point, and the two paths not identical.
 */
test('a reciprocal pair stays on the points and still reads as two lines', async () => {
  const seedIn = await freshDiagram('reciprocal');
  const a = await seedIn('Recip A', 0, 0);
  const b = await seedIn('Recip B', 400, 0);
  await stack.op({ op: 'add_edge', source: a, target: b, label: 'calls' }, 'reciprocal');
  await stack.op({ op: 'add_edge', source: b, target: a, label: 'answers' }, 'reciprocal');

  await until('both edges to render', async () =>
    (await stack.page.locator('.react-flow__edge').count()) >= 2,
  );

  const boxA = points(await flowRect(a));
  const boxB = points(await flowRect(b));

  assertOnPoint(await pathStart(`${a}->${b}`), boxA.right, 'forward source');
  assertOnPoint(await pathEnd(`${a}->${b}`), boxB.left, 'forward target');
  assertOnPoint(await pathStart(`${b}->${a}`), boxB.left, 'reverse source');
  assertOnPoint(await pathEnd(`${b}->${a}`), boxA.right, 'reverse target');

  const forward = await stack.page.getAttribute(
    `.react-flow__edge[data-id="${a}->${b}"] path.react-flow__edge-path`, 'd');
  const reverse = await stack.page.getAttribute(
    `.react-flow__edge[data-id="${b}->${a}"] path.react-flow__edge-path`, 'd');
  assert.notEqual(forward, reverse, 'the pair must not draw as one line');
});

/*
 * No cap on how many edges meet a node, and no cap per point either — several arrows
 * converging on one face is a normal shape for a hub and must not be quietly limited.
 */
test('many edges can meet the same node on the same point', async () => {
  const seedIn = await freshDiagram('hub');
  // Far enough left that the horizontal gap dominates for all three, so every edge really
  // does choose the same face — otherwise this tests the face rule, not the crowding.
  const hub = await seedIn('Hub', 900, 300);
  const spokes = [
    await seedIn('Spoke 1', 0, 240),
    await seedIn('Spoke 2', 0, 300),
    await seedIn('Spoke 3', 0, 360),
  ];
  for (const spoke of spokes) {
    await stack.op({ op: 'add_edge', source: spoke, target: hub }, 'hub');
  }

  await until('every edge to render', async () =>
    (await stack.page.locator('.react-flow__edge').count()) >= 3,
  );

  const left = points(await flowRect(hub)).left;
  for (const spoke of spokes) {
    assertOnPoint(await pathEnd(`${spoke}->${hub}`), left, `edge from ${spoke}`);
  }

  const graph = await stack.graph('hub');
  assert.equal(graph.edges.length, 3, 'all three edges exist on the server');
});

/*
 * `arrow` is the human's control too, not only the agent's — so the header has to reach a
 * selected edge and the canvas has to draw what the server stored. The marker attributes
 * are the only evidence: an arrowhead is an SVG marker, invisible to any style assertion.
 */
test('the header sets which ends of a selected edge carry an arrowhead', async () => {
  const seedIn = await freshDiagram('arrows');
  const a = await seedIn('Arrow A', 0, 0);
  const b = await seedIn('Arrow B', 0, 260);
  await stack.op({ op: 'add_edge', source: a, target: b }, 'arrows');

  const id = `${a}->${b}`;
  const selector = `.react-flow__edge[data-id="${id}"]`;
  await until('the edge to render', async () =>
    (await stack.page.locator(selector).count()) > 0,
  );

  const path = stack.page.locator(`${selector} path.react-flow__edge-path`);
  assert.equal(await path.getAttribute('marker-start'), null, 'one arrowhead to begin with');

  await stack.page.locator(`${selector} .react-flow__edge-path`).click({ force: true });
  await until('the edge to report itself selected', async () =>
    (await stack.page.locator(`${selector}.selected`).count()) > 0,
  );

  await stack.page.locator('.arrows button[aria-label="both directions"]').click();

  const stored = await until('the arrow to reach the server', async () => {
    const graph = await stack.graph('arrows');
    return graph.edges.find((e: any) => e.id === id)?.arrow ?? null;
  });
  assert.equal(stored, 'both');

  await until('the second arrowhead to render', async () =>
    Boolean(await path.getAttribute('marker-start')),
  );

  await stack.page.locator('.arrows button[aria-label="no direction"]').click();
  await until('both arrowheads to go', async () => {
    const graph = await stack.graph('arrows');
    if (graph.edges.find((e: any) => e.id === id)?.arrow !== 'none') return false;
    return (await path.getAttribute('marker-end')) === null;
  });
});

/*
 * The point you drew an edge onto is the point it stays on.
 *
 * Recomputing it made the arrow jump between points as a box was dragged past a diagonal,
 * which is the complaint that produced #15's follow-up. Drawing pins both ends, and moving
 * a node afterwards must not move them.
 */
test('an edge drawn onto a point stays on it when the node moves', async () => {
  const seedIn = await freshDiagram('pinned');
  const a = await seedIn('Pin A', 0, 0);
  // Close together on purpose. `fitView` zooms *in* on a diagram this empty — at scale 2 a
  // 400px gap puts the second node's point past the right edge of the window, and the drag
  // then ends on nothing. Same hazard as the resize suite's, in the opposite direction.
  const b = await seedIn('Pin B', 240, 0);

  // Seeding changes what `fitView` fits, so the viewport moves again after the nodes land.
  // These handles are measured in screen pixels, so a box taken mid-animation is ~hundreds
  // of pixels off and the drag starts on empty canvas.
  await settleViewport(stack.page);

  // Draw from A's *top* — the side the automatic rule would never choose for a neighbour
  // sitting directly to the right, so a jump back to `right` is unmistakable.
  const from = await stack.page
    .locator(`.react-flow__node[data-id="${a}"] .react-flow__handle-top`)
    .boundingBox();
  const to = await stack.page
    .locator(`.react-flow__node[data-id="${b}"] .react-flow__handle-top`)
    .boundingBox();
  assert.ok(from && to, 'both points must be present to drag between them');

  await dragMouse(
    stack.page,
    { x: from.x + from.width / 2, y: from.y + from.height / 2 },
    { x: to.x + to.width / 2, y: to.y + to.height / 2 },
  );

  const edge = await until('the edge to reach the server', async () => {
    const graph = await stack.graph('pinned');
    return graph.edges.find((e: any) => e.source === a && e.target === b) ?? null;
  });
  assert.equal(edge.sourceSide, 'top', 'drawing pins the end it was drawn from');
  assert.equal(edge.targetSide, 'top');

  await until('the edge to render on the pinned point', async () =>
    Math.abs((await pathStart(edge.id)).y - (await flowRect(a)).y) < 3,
  );

  // Now drag A well below B. The automatic rule would swing this to another face; pinned,
  // it must not budge off the top.
  const centre = await nodeCentre(stack.page, a);
  await dragMouse(stack.page, centre, { x: centre.x + 60, y: centre.y + 320 });
  await until('the move to reach the server', async () => {
    const node = await stack.graph('pinned').then((g: any) => g.nodes.find((n: any) => n.id === a));
    // Screen pixels, halved by the scale-2 fit — so this threshold is well under the drag.
    return node.position.y > 100;
  });

  assertOnPoint(await pathStart(edge.id), points(await flowRect(a)).top, 'after moving the node');
});

/*
 * Grabbing the end of an edge and dropping it on another point.
 *
 * This was impossible for a while and nothing caught it: the canvas drew its own geometry
 * while React Flow placed the reconnect anchors at whichever handle it had bound, ~120px
 * across and ~84px above the visible line. Every existing test asserted where the line was
 * *drawn*, which was right — the part that was wrong was where you could grab it.
 */
test('an edge end can be grabbed and moved to another point', async () => {
  const seedIn = await freshDiagram('repoint');
  const a = await seedIn('Repoint A', 0, 0);
  const b = await seedIn('Repoint B', 240, 0);
  await stack.op({ op: 'add_edge', source: a, target: b }, 'repoint');

  const id = `${a}->${b}`;
  await until('the edge to render', async () =>
    (await stack.page.locator(`.react-flow__edge[data-id="${id}"]`).count()) > 0,
  );
  await settleViewport(stack.page);

  const before = await stack.graph('repoint').then((g: any) => g.edges[0]);
  assert.equal(before.targetSide, 'left', 'seeded facing the source');

  // The anchor has to be where the line is. If it is not, this drag grabs empty canvas and
  // the edge never moves — which is exactly how the bug presented.
  const anchor = await stack.page
    .locator(`.react-flow__edge[data-id="${id}"] .react-flow__edgeupdater-target`)
    .boundingBox();
  const landing = await stack.page
    .locator(`.react-flow__node[data-id="${b}"] .react-flow__handle-top`)
    .boundingBox();
  assert.ok(anchor && landing, 'the reconnect anchor and the destination point must exist');

  await dragMouse(
    stack.page,
    { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 },
    { x: landing.x + landing.width / 2, y: landing.y + landing.height / 2 },
  );

  const moved = await until('the new point to reach the server', async () => {
    const edge = await stack.graph('repoint').then((g: any) => g.edges[0]);
    return edge?.targetSide === 'top' ? edge : null;
  });

  assert.equal(moved.id, id, 're-pointing must not regenerate the id — nothing reconnected');
  assert.equal(moved.source, a);
  assert.equal(moved.target, b);
  // The server confirming is not the canvas having drawn it — wait for the push to land.
  await until('the line to redraw on the new point', async () => {
    const end = await pathEnd(id);
    return Math.abs(end.y - (await flowRect(b)).y) < 3;
  });
  assertOnPoint(await pathEnd(id), points(await flowRect(b)).top, 'after re-pointing');
});
