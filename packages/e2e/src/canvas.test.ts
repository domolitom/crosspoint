import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
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
