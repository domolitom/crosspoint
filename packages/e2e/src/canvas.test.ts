import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  API,
  dragMouse,
  nodeCentre,
  openCanvas,
  startStack,
  until,
  type Stack,
} from './harness.js';

/**
 * Canvas interaction tests, driven through a real browser.
 *
 * This is the layer where every silent bug in this project has lived, and where the core
 * and server suites reach nothing. Each of the following was shipped broken and found by
 * hand, not by a test:
 *
 *   - `onEdgesChange` missing, so edges could never be selected
 *   - `deleteKeyCode` defaulting to Backspace alone, so Delete did nothing
 *   - `OnNodeDrag`'s third argument ignored, so a multi-node drag persisted one node
 *   - the node rebuild picking out `label`, dropping colour and everything else
 *   - every colour swatch rendering identical grey, while colour assertions passed
 *
 * That last one is the standard here: assert on the thing a human would look at. A test
 * that measures a proxy can pass while the screen is visibly wrong.
 */

let stack: Stack;

before(async () => {
  stack = await startStack();
}, { timeout: 120_000 });

after(async () => {
  await stack?.stop();
});

/** Seed a node at a known position so assertions are deterministic. */
async function seed(label: string, x: number, y: number): Promise<string> {
  const { status } = await stack.op({ op: 'add_node_at', label, position: { x, y } });
  assert.equal(status, 200, `seeding ${label} failed`);
  const graph = await stack.graph();
  const node = graph.nodes.find((n: any) => n.data.label === label);
  assert.ok(node, `seeded node ${label} not found`);
  return node.id;
}

const nodeById = async (id: string) => {
  const graph = await stack.graph();
  return graph.nodes.find((n: any) => n.id === id);
};

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

test('dragging from the palette creates a node near the drop point', async () => {
  await openCanvas(stack);
  const label = 'Dropped here';

  // The drop handler asks for a label with window.prompt; answer it before dropping.
  await stack.page.evaluate((text) => {
    (window as any).prompt = () => text;
  }, label);

  const palette = await stack.page.locator('.palette-node').boundingBox();
  const pane = await stack.page.locator('.react-flow__pane').boundingBox();
  assert.ok(palette && pane);
  const drop = { x: pane.x + pane.width * 0.62, y: pane.y + pane.height * 0.4 };

  // HTML5 drag-and-drop cannot be driven by Playwright's mouse: the dataTransfer object
  // only exists on real drag events. Dispatch them directly, sharing one DataTransfer so
  // the payload set in dragstart is visible to dragover and drop, exactly as a browser
  // would present it. This exercises the app's own handlers and its screen-to-flow
  // conversion; what it does not exercise is the browser's native drag gesture.
  const flowPoint = await stack.page.evaluate(
    ({ drop }) => {
      const source = document.querySelector('.palette-node')!;
      const pane = document.querySelector('.react-flow__pane')!;
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: drop.x, clientY: drop.y };
      pane.dispatchEvent(new DragEvent('dragover', init));
      pane.dispatchEvent(new DragEvent('drop', init));
      return drop;
    },
    { drop },
  );

  const created = await until('the dropped node to reach the server', async () => {
    const graph = await stack.graph();
    return graph.nodes.find((n: any) => n.data.label === label) ?? null;
  });

  // Compare against where the canvas itself says that screen point maps to, rather than
  // recomputing the viewport transform here and testing our own arithmetic.
  const expected = await stack.page.evaluate((point) => {
    const el = document.querySelector('.react-flow__viewport') as HTMLElement;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    const pane = document.querySelector('.react-flow__pane')!.getBoundingClientRect();
    return {
      x: (point.x - pane.left - m.e) / m.a,
      y: (point.y - pane.top - m.f) / m.d,
    };
  }, flowPoint);

  assert.ok(
    Math.abs(created.position.x - expected.x) < 40 &&
      Math.abs(created.position.y - expected.y) < 40,
    `node landed at ${JSON.stringify(created.position)}, expected near ${JSON.stringify(expected)}`,
  );
});

test('a colour swatch colours the selection, and clearing removes the key', async () => {
  const id = await seed('Colour me', 600, 700);
  await openCanvas(stack);
  await until('the node to render', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${id}"]`).count()) > 0,
  );

  const swatch = stack.page.locator('.swatch[aria-label="amber"]');
  assert.equal(await swatch.isDisabled(), true, 'the palette is inert with nothing selected');

  await stack.page.locator(`.react-flow__node[data-id="${id}"]`).click();
  await until('the swatch to become usable', async () => !(await swatch.isDisabled()));

  const before = await stack.page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel)!).backgroundColor,
    `.react-flow__node[data-id="${id}"]`,
  );

  await swatch.click();

  const coloured = await until('the colour to reach the server', async () => {
    const node = await nodeById(id);
    return node.data.color === 'amber' ? node : null;
  });
  assert.equal(coloured.data.color, 'amber');

  const after = await until('the node to repaint', async () => {
    const bg = await stack.page.evaluate(
      (sel) => getComputedStyle(document.querySelector(sel)!).backgroundColor,
      `.react-flow__node[data-id="${id}"]`,
    );
    return bg !== before ? bg : null;
  });
  assert.equal(after, 'rgb(254, 243, 199)', `amber fill should be #fef3c7, got ${after}`);

  await stack.page.locator('.swatch.swatch-clear').click();
  const cleared = await until('the colour to be cleared', async () => {
    const node = await nodeById(id);
    return node.data.color === undefined ? node : null;
  });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(cleared.data, 'color'),
    'clearing must delete the key, not store a sentinel',
  );
});

// The swatches once all rendered identical grey while every colour assertion passed,
// because the assertions measured nodes. This one measures the buttons.
test('the swatches render as visually distinct colours', async () => {
  await openCanvas(stack);
  const colours = await stack.page.evaluate(() =>
    [...document.querySelectorAll('.swatch')].map((el) => ({
      label: el.getAttribute('aria-label'),
      background: getComputedStyle(el).backgroundColor,
    })),
  );

  assert.ok(colours.length >= 7, `expected at least 7 swatches, got ${colours.length}`);

  const named = colours.filter((c) => c.label !== 'no colour');
  const distinct = new Set(named.map((c) => c.background));
  assert.equal(
    distinct.size,
    named.length,
    `swatches share backgrounds: ${JSON.stringify(colours)}`,
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

test('nodes size themselves to their label, within the clamp', async () => {
  const short = await seed('A', 1600, 400);
  const long = await seed(
    'Authentication and authorization gateway for the public API surface',
    1600,
    600,
  );
  await openCanvas(stack);
  await until('both nodes to render', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${long}"]`).count()) > 0,
  );

  // offsetWidth, not getBoundingClientRect: the latter is measured through React Flow's
  // zoom transform, so fitView on a wide graph reports a 120px node as ~66px and the
  // clamp assertions fail against the app being perfectly correct.
  const [shortWidth, longWidth] = await stack.page.evaluate(
    (ids) =>
      ids.map(
        (id) =>
          (document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement)
            .offsetWidth,
      ),
    [short, long],
  );
  assert.ok(
    longWidth > shortWidth,
    `a long label must render wider: short=${shortWidth} long=${longWidth}`,
  );
  assert.ok(shortWidth >= 120, `short node should respect the 120px floor, got ${shortWidth}`);
  assert.ok(longWidth <= 320, `long node should respect the 320px cap, got ${longWidth}`);
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
  await until('the first diagram to come back', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${here}"]`).count()) > 0,
  );
});

/*
 * Subcanvases. A node can hold another diagram, opened in a panel beside it.
 *
 * The riskiest behaviour here is that a panel edit lands in the subcanvas and NOT in the
 * parent — the panel writes to a diagram that is deliberately not the active one, so a
 * targeting mistake would silently corrupt the diagram the human is looking at.
 */

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
