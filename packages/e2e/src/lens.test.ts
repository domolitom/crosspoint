import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  dragMouse,
  fixtures,
  openCanvas,
  startStack,
  until,
  type Stack,
} from './harness.js';

/*
 * Subcanvases. A node can hold another diagram, opened in a panel beside it.
 *
 * The riskiest behaviour here is that a panel edit lands in the subcanvas and NOT in the
 * parent — the panel writes to a diagram that is deliberately not the active one, so a
 * targeting mistake would silently corrupt the diagram the human is looking at.
 */

let stack: Stack;

before(async () => {
  stack = await startStack();
}, { timeout: 120_000 });

after(async () => {
  await stack?.stop();
});

const { seed, freshDiagram } = fixtures(() => stack);

/** Give a node a subcanvas holding two nodes, and return its name. */
async function seedSubcanvas(nodeId: string, name: string): Promise<string> {
  await stack.createDiagram(name);
  await stack.op(
    {
      op: 'generate_graph',
      nodes: [{ label: 'Tokenize' }, { label: 'Validate' }],
      edges: [{ source: 'tokenize', target: 'validate' }],
    },
    name,
  );
  const { status } = await stack.op({ op: 'update_node', id: nodeId, subcanvas: name });
  assert.equal(status, 200, 'linking the subcanvas failed');
  return name;
}

test('the lens badge marks only the nodes that have a subcanvas', async () => {
  const plain = await seed('No detail', 600, 600);
  const linked = await seed('Has detail', 600, 750);
  await seedSubcanvas(linked, 'has-detail-impl');

  await openCanvas(stack);
  await until('both nodes to render', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${linked}"]`).count()) > 0,
  );

  // Opacity, not presence: the badge exists on every node so a bare one can be clicked to
  // create a subcanvas, but only a linked node advertises itself at rest.
  const opacity = (id: string) =>
    stack.page
      .locator(`.react-flow__node[data-id="${id}"] .cp-lens`)
      .evaluate((el) => getComputedStyle(el).opacity);

  assert.equal(await opacity(linked), '1', 'a node with detail shows its lens');
  assert.equal(await opacity(plain), '0', 'a node without one does not');
  assert.equal(
    await stack.page.locator(`.react-flow__node[data-id="${linked}"] .cp-lens-linked`).count(),
    1,
    'and it is marked as linked, not merely visible',
  );
});

test('clicking the lens opens a panel showing that diagram', async () => {
  const graph = await stack.graph();
  const linked = graph.nodes.find((n: any) => n.data.subcanvas === 'has-detail-impl');
  assert.ok(linked, 'expected the linked node from the previous test');

  await stack.page.locator(`.react-flow__node[data-id="${linked.id}"] .cp-lens`).click();
  await until('the panel to open', async () => (await stack.page.locator('.lens-panel').count()) > 0);

  await until('the panel to render the subcanvas', async () => {
    const labels = await stack.page.locator('.lens-panel .react-flow__node').allInnerTexts();
    return labels.length === 2 && labels.join(' ').includes('Tokenize');
  });

  const crumbs = await stack.page.locator('.lens-panel .lens-crumb').allInnerTexts();
  assert.deepEqual(
    crumbs.map((c) => c.trim()),
    ['has-detail-impl'],
    'the trail starts at the diagram we opened',
  );

  // The parent must still be on screen — the whole point of a panel over a switch.
  assert.ok(
    (await stack.page.locator(`.react-flow__node[data-id="${linked.id}"]`).count()) > 0,
    'the parent node is still visible behind the panel',
  );
});

test('editing inside the panel writes to the subcanvas, not the parent', async () => {
  const parentBefore = await stack.graph();
  const subBefore = await stack.graph('has-detail-impl');

  // Drag a node inside the panel. Position is the cheapest edit to verify precisely.
  const target = stack.page.locator('.lens-panel .react-flow__node').first();
  const id = await target.getAttribute('data-id');
  const box = await target.boundingBox();
  assert.ok(box && id, 'expected a node in the panel');
  await dragMouse(
    stack.page,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2 + 60, y: box.y + box.height / 2 + 45 },
  );

  const moved = await until('the panel edit to reach its own diagram', async () => {
    const after = await stack.graph('has-detail-impl');
    const before = subBefore.nodes.find((n: any) => n.id === id);
    const now = after.nodes.find((n: any) => n.id === id);
    return now && (now.position.x !== before.position.x || now.position.y !== before.position.y)
      ? { before, now }
      : null;
  });
  assert.ok(moved, 'the node moved in the subcanvas');

  const parentAfter = await stack.graph();
  assert.deepEqual(
    parentAfter.nodes.map((n: any) => ({ id: n.id, ...n.position })),
    parentBefore.nodes.map((n: any) => ({ id: n.id, ...n.position })),
    'and nothing in the parent diagram moved',
  );
});

test('lensing deeper extends the trail, and a crumb walks back', async () => {
  // Give a node *inside* the panel its own subcanvas, then lens into it.
  const sub = await stack.graph('has-detail-impl');
  const inner = sub.nodes[0].id;
  await stack.createDiagram('deeper');
  await stack.op({ op: 'add_node', label: 'Deepest' }, 'deeper');
  await stack.op({ op: 'update_node', id: inner, subcanvas: 'deeper' }, 'has-detail-impl');

  await until('the inner lens to appear', async () =>
    (await stack.page.locator(`.lens-panel .react-flow__node[data-id="${inner}"] .cp-lens-linked`).count()) > 0,
  );
  await stack.page.locator(`.lens-panel .react-flow__node[data-id="${inner}"] .cp-lens`).click();

  await until('the trail to have two steps', async () => {
    const crumbs = await stack.page.locator('.lens-panel .lens-crumb').allInnerTexts();
    return crumbs.length === 2;
  });
  const deep = await stack.page.locator('.lens-panel .lens-crumb').allInnerTexts();
  assert.deepEqual(deep.map((c) => c.trim()), ['has-detail-impl', 'deeper']);
  assert.ok(
    (await stack.page.locator('.lens-panel').count()) === 1,
    'still one panel, not a stack of them',
  );

  // Walking back up replaces the contents rather than opening a second panel.
  await stack.page.locator('.lens-panel .lens-crumb').first().click();
  await until('the trail to shrink', async () => {
    const crumbs = await stack.page.locator('.lens-panel .lens-crumb').allInnerTexts();
    return crumbs.length === 1;
  });
});

test('opening another lens replaces the open panel', async () => {
  // Link a second top-level node, then lens it while a panel is already open.
  const other = await seed('Other detail', 900, 600);
  await stack.createDiagram('other-impl');
  await stack.op({ op: 'add_node', label: 'Elsewhere' }, 'other-impl');
  await stack.op({ op: 'update_node', id: other, subcanvas: 'other-impl' });

  await until('the second lens to appear', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${other}"] .cp-lens-linked`).count()) > 0,
  );
  await stack.page.locator(`.react-flow__node[data-id="${other}"] .cp-lens`).click();

  await until('the panel to show the other diagram', async () => {
    const crumbs = await stack.page.locator('.lens-panel .lens-crumb').allInnerTexts();
    return crumbs.length === 1 && crumbs[0].trim() === 'other-impl';
  });
  assert.equal(await stack.page.locator('.lens-panel').count(), 1, 'exactly one panel');
});

// Two live editable views of one graph would fight each other's pushes, and the trail
// would stop meaning anything.
test('lensing the diagram you are already in is refused visibly', async () => {
  const active = (await stack.page.locator('.diagram-switcher').inputValue()).trim();
  const node = await seed('Points at itself', 900, 900);
  await stack.op({ op: 'update_node', id: node, subcanvas: active });

  await until('the self-referential lens to appear', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${node}"] .cp-lens-linked`).count()) > 0,
  );
  await stack.page.locator(`.react-flow__node[data-id="${node}"] .cp-lens`).click();

  // Visibly refused: an error in the header, not a panel that silently fails to appear.
  const message = await until('the refusal to be shown', async () => {
    const text = await stack.page.locator('.bar .error').allInnerTexts();
    return text.find((t) => t.includes(active)) ?? null;
  });
  assert.match(message, /already in/i);
  const crumbs = await stack.page.locator('.lens-panel .lens-crumb').allInnerTexts();
  assert.ok(
    !crumbs.some((c) => c.trim() === active),
    'and the active diagram was not opened in a panel',
  );
});

test('closing the panel leaves the main canvas intact', async () => {
  if ((await stack.page.locator('.lens-panel').count()) === 0) {
    // Re-open one so this test does not depend on which state the previous left behind.
    const graph = await stack.graph();
    const linked = graph.nodes.find((n: any) => n.data.subcanvas === 'other-impl');
    await stack.page.locator(`.react-flow__node[data-id="${linked.id}"] .cp-lens`).click();
    await until('a panel to be open', async () =>
      (await stack.page.locator('.lens-panel').count()) > 0,
    );
  }

  const before = (await stack.graph()).nodes.length;
  await stack.page.locator('.lens-panel .lens-close').click();
  await until('the panel to close', async () =>
    (await stack.page.locator('.lens-panel').count()) === 0,
  );
  assert.equal((await stack.graph()).nodes.length, before, 'closing changed nothing');
});

/**
 * Resizing the panel.
 *
 * These seed their own node and subcanvas rather than inheriting whatever the previous
 * test left open — an earlier draft chained off that state and failed for reasons that had
 * nothing to do with resizing.
 *
 * The sharpest assertion is a negative one: a resize must produce no op and no rev change.
 * Panel size is presentation state, and this project has already shipped one stray no-op
 * `move_node`, so a gesture that quietly writes to the graph is a live risk.
 */

/** Seed a node with a subcanvas, reload, and open its panel. Returns the panel box. */
async function openFreshPanel(label: string, name: string, y: number) {
  const node = await seed(label, 300, y);
  await seedSubcanvas(node, name);
  await openCanvas(stack);
  await until('the seeded node to render', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${node}"]`).count()) > 0,
  );
  await stack.page.locator(`.react-flow__node[data-id="${node}"] .cp-lens`).click();
  await until('the panel to open', async () =>
    (await stack.page.locator('.lens-panel').count()) > 0,
  );
  const box = await stack.page.locator('.lens-panel').boundingBox();
  assert.ok(box, 'the panel has no bounding box');
  return box;
}

async function dragGrip(dx: number, dy: number) {
  const grip = await stack.page.locator('.lens-panel .lens-resize').boundingBox();
  assert.ok(grip, 'the resize grip is not rendered');
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };

  // Confirm the grip is the topmost element at that point. A silent miss here looks
  // exactly like "resizing is broken", and cost real time before this check existed.
  const hit = await stack.page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const panel = document.querySelector('.lens-panel') as HTMLElement | null;
      return {
        at: el ? `${el.tagName}.${el.className}` : 'nothing',
        view: `${window.innerWidth}x${window.innerHeight}`,
        panel: panel ? `${panel.style.left} ${panel.style.top} ${panel.style.width}` : 'none',
      };
    },
    { x: from.x, y: from.y },
  );
  assert.match(
    hit.at,
    /lens-resize/,
    `grip at (${from.x},${from.y}) hit ${hit.at}; viewport ${hit.view}; panel ${hit.panel}`,
  );

  await dragMouse(stack.page, from, { x: from.x + dx, y: from.y + dy });
}

/** The same clamp the component applies, so expectations survive a small viewport. */
async function expectedSize(w: number, h: number) {
  const view = await stack.page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  return {
    w: Math.min(Math.max(w, 260), view.w - 32),
    h: Math.min(Math.max(h, 200), view.h - 72),
  };
}

test('dragging the grip resizes the panel', async () => {
  const before = await openFreshPanel('Resize me', 'resize-impl', 900);
  const revBefore = (await stack.graph()).rev;

  await dragGrip(120, 80);

  const want = await expectedSize(before.width + 120, before.height + 80);
  const after = await until('the panel to grow', async () => {
    const box = await stack.page.locator('.lens-panel').boundingBox();
    return box && Math.abs(box.width - want.w) < 24 ? box : null;
  });

  assert.ok(
    Math.abs(after.height - want.h) < 24,
    `height ${before.height} -> ${after.height}, expected about ${want.h}`,
  );

  // The point: this resized a window, not a diagram.
  assert.equal((await stack.graph()).rev, revBefore, 'resizing must not touch the graph');
});

test('the panel refuses to shrink below its minimum', async () => {
  await dragGrip(-900, -900);

  const box = await stack.page.locator('.lens-panel').boundingBox();
  assert.ok(box, 'the panel vanished');
  assert.ok(box.width >= 260 && box.width < 290, `width clamped to 260, got ${box.width}`);
  assert.ok(box.height >= 200 && box.height < 230, `height clamped to 200, got ${box.height}`);
});

test('a resized panel is remembered for that diagram', async () => {
  await dragGrip(180, 130);
  const resized = await stack.page.locator('.lens-panel').boundingBox();
  assert.ok(resized, 'no box after resizing');
  assert.ok(resized.width > 300, `expected a grown panel, got ${resized.width}`);

  await stack.page.locator('.lens-panel .lens-close').click();
  await until('the panel to close', async () =>
    (await stack.page.locator('.lens-panel').count()) === 0,
  );

  const linked = (await stack.graph()).nodes.find(
    (n: any) => n.data.subcanvas === 'resize-impl',
  );
  await stack.page.locator(`.react-flow__node[data-id="${linked.id}"] .cp-lens`).click();
  const reopened = await until('the panel to reopen', async () => {
    const box = await stack.page.locator('.lens-panel').boundingBox();
    return box ?? null;
  });

  assert.ok(
    Math.abs(reopened.width - resized.width) < 4 && Math.abs(reopened.height - resized.height) < 4,
    `reopened ${reopened.width}x${reopened.height}, expected ${resized.width}x${resized.height}`,
  );
});
test('creating a subcanvas asks nothing and names itself from the node', async () => {
  // Back to a diagram with a node to lens.
  const seedIn = await freshDiagram('lens-naming');
  const id = await seedIn('Parse input', 0, 0);
  const node = stack.page.locator(`.react-flow__node[data-id="${id}"]`);

  await node.locator('.cp-lens').click();

  // No input, no dialog — the panel just opens on a diagram named from the label.
  const crumbs = await until('the panel to open', async () => {
    const c = await stack.page.locator('.lens-panel .lens-crumb').allTextContents();
    return c.length ? c : null;
  });
  assert.equal(
    await stack.page.locator('.cp-diagram-input').count(),
    0,
    'nothing should have asked for a name',
  );
  assert.match(crumbs[0].trim(), /^parse-input-detail$/, `got ${crumbs[0]}`);

  const linked = (await stack.graph('lens-naming')).nodes.find((n: any) => n.id === id);
  assert.equal(linked.data.subcanvas, 'parse-input-detail');
});
/**
 * Moving the lens panel.
 *
 * The panel is anchored beside its node, which means it covers the part of the parent it
 * exists to keep visible — the user reported it as a bug and they were right. Dragging the
 * header moves it; the position sticks per diagram, and double-clicking the bar re-anchors.
 */
test('the lens panel can be dragged by its header', async () => {
  const seedIn = await freshDiagram('panel-move');
  const parent = await seedIn('Move parent', 0, 0);
  await stack.createDiagram('panel-move-child');
  await stack.op(
    {
      op: 'generate_graph',
      nodes: [{ label: 'Inner one' }, { label: 'Inner two' }],
      edges: [{ source: 'inner-one', target: 'inner-two' }],
      replace: true,
    },
    'panel-move-child',
  );
  await stack.op({ op: 'update_node', id: parent, subcanvas: 'panel-move-child' }, 'panel-move');

  await until('the lens badge to appear', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${parent}"] .cp-lens`).count()) > 0,
  );
  await stack.page.locator(`.react-flow__node[data-id="${parent}"] .cp-lens`).click();
  await stack.page.waitForSelector('.lens-panel');

  const anchored = await stack.page.locator('.lens-panel').boundingBox();
  assert.ok(anchored, 'the panel has no box');

  const bar = await stack.page.locator('.lens-panel-bar').boundingBox();
  assert.ok(bar, 'no header to grab');

  /*
   * Drag away from the nearest edge, not always left.
   *
   * A dragged position is clamped to the viewport, and where the panel anchors depends on
   * where fitView put its node — which differs with font metrics, so it is not the same on
   * every platform. Hardcoding -240 assumed 240px of room to the left; on Linux the panel
   * anchored at x=48, the drag clamped at 0, and a working drag looked like a broken one.
   */
  const dx = anchored.x >= 240 ? -240 : 240;
  await dragMouse(
    stack.page,
    { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 },
    { x: bar.x + bar.width / 2 + dx, y: bar.y + bar.height / 2 + 120 },
  );

  /*
   * A drag that does nothing is a positioning question before it is a handler question, so
   * report what was actually under the cursor rather than a bare timeout. This failed on
   * Linux while passing on macOS, and the bare message said nothing about why.
   */
  const grab = { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 };
  const moved = await until('the panel to move', async () => {
    const box = await stack.page.locator('.lens-panel').boundingBox();
    return box && Math.abs(box.x - anchored.x) > 100 ? box : null;
  }).catch(async (err) => {
    const hit = await stack.page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const panel = document.querySelector('.lens-panel') as HTMLElement | null;
      return {
        at: el ? `${el.tagName.toLowerCase()}.${el.className}` : 'nothing',
        panel: panel ? panel.getBoundingClientRect().toJSON() : null,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    }, grab);
    throw new Error(
      `${(err as Error).message}\n` +
        `  grabbed at (${Math.round(grab.x)}, ${Math.round(grab.y)}) which holds ${hit.at}\n` +
        `  anchored at (${Math.round(anchored.x)}, ${Math.round(anchored.y)})\n` +
        `  panel now ${JSON.stringify(hit.panel)}\n` +
        `  viewport ${JSON.stringify(hit.viewport)}`,
    );
  });
  assert.ok(
    Math.abs(moved.x - (anchored.x + dx)) < 24 && Math.abs(moved.y - (anchored.y + 120)) < 24,
    `expected ~(${anchored.x + dx}, ${anchored.y + 120}), got (${moved.x}, ${moved.y})`,
  );
});

// Dragging inside the panel is the sub-canvas's own gesture, not the panel's.
test('dragging the panel body pans the subcanvas instead of moving the panel', async () => {
  const panel = await stack.page.locator('.lens-panel').boundingBox();
  const body = await stack.page.locator('.lens-panel-body').boundingBox();
  assert.ok(panel && body);

  /*
   * Grab a corner, not the centre. The centre of a two-node subgraph sits on the edge path
   * between them, so a drag there grabs the edge and nothing pans — which looks exactly like
   * "panning is broken". Verified with elementFromPoint: the corner is `react-flow__pane`.
   */
  const from = { x: body.x + 40, y: body.y + body.height - 40 };
  const transform = () =>
    stack.page.evaluate(() => {
      const vp = document.querySelector('.lens-panel .react-flow__viewport');
      return vp ? getComputedStyle(vp).transform : 'none';
    });

  const before = await transform();
  await dragMouse(stack.page, from, { x: from.x + 110, y: from.y - 60 });

  await until('the subcanvas to pan', async () => (await transform()) !== before);
  const after = await stack.page.locator('.lens-panel').boundingBox();
  assert.ok(
    Math.abs(after!.x - panel.x) < 4 && Math.abs(after!.y - panel.y) < 4,
    'the panel itself must not have moved',
  );
});

test('a dragged panel is remembered, and double-clicking the bar re-anchors it', async () => {
  const moved = await stack.page.locator('.lens-panel').boundingBox();
  assert.ok(moved);

  await stack.page.locator('.lens-panel .lens-close').click();
  await until('the panel to close', async () =>
    (await stack.page.locator('.lens-panel').count()) === 0,
  );
  const parent = (await stack.graph('panel-move')).nodes.find((n: any) => n.data.subcanvas);
  await stack.page.locator(`.react-flow__node[data-id="${parent.id}"] .cp-lens`).click();
  await stack.page.waitForSelector('.lens-panel');

  const reopened = await until('the panel to reopen where it was left', async () => {
    const box = await stack.page.locator('.lens-panel').boundingBox();
    return box && Math.abs(box.x - moved.x) < 6 && Math.abs(box.y - moved.y) < 6 ? box : null;
  });
  assert.ok(reopened, 'the dragged position should survive a reopen');

  const bar = await stack.page.locator('.lens-panel-bar').boundingBox();
  await stack.page.mouse.dblclick(bar!.x + bar!.width / 2, bar!.y + bar!.height / 2);

  await until('the panel to re-anchor away from the dragged spot', async () => {
    const box = await stack.page.locator('.lens-panel').boundingBox();
    return box ? Math.abs(box.x - moved.x) > 50 : false;
  });
});
