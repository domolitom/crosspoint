import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  API,
  dragMouse,
  fixtures,
  openCanvas,
  startStack,
  until,
  type Stack,
} from './harness.js';

/**
 * Manual node resizing. Auto-sized by default, a drag pins it.
 *
 * Note the handles scale with the canvas, so at low zoom they become sub-pixel and
 * effectively ungrabbable — `freshDiagram` exists for exactly this reason. A probe that
 * skipped it measured a node at 60x20 and reported resizing as broken when it was not.
 */

let stack: Stack;

before(async () => {
  stack = await startStack();
}, { timeout: 120_000 });

after(async () => {
  await stack?.stop();
});

const { freshDiagram } = fixtures(() => stack);

/** Grab a resize handle and drag it, returning the pre-drag rev. */
async function dragHandle(id: string, corner: string, dx: number, dy: number) {
  const sel = `.react-flow__node[data-id="${id}"]`;
  await stack.page.locator(sel).click();
  await until(
    'the node to be selected',
    async () => (await stack.page.locator(`${sel}.selected`).count()) > 0,
  );

  const handle = await stack.page
    .locator(`${sel} .react-flow__resize-control.handle.${corner}`)
    .boundingBox();
  assert.ok(handle, `no ${corner} resize handle`);

  const rev = (await stack.graph()).rev;
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await dragMouse(stack.page, from, { x: from.x + dx, y: from.y + dy });
  return rev;
}

test('resize handles appear only on a selected node', async () => {
  const seedIn = await freshDiagram('resize-me');
  const id = await seedIn('Resizable', 0, 0);

  const sel = `.react-flow__node[data-id="${id}"]`;
  assert.equal(
    await stack.page.locator(`${sel} .react-flow__resize-control`).count(),
    0,
    'an unselected node shows no handles',
  );

  await stack.page.locator(sel).click();
  await until(
    'handles to appear',
    async () => (await stack.page.locator(`${sel} .react-flow__resize-control`).count()) > 0,
  );
});

test('dragging a handle pins the size, in one op', async () => {
  const graph = await stack.graph();
  const node = graph.nodes.find((n: any) => n.data.label === 'Resizable');
  assert.equal(node.size, undefined, 'starts auto-sized, carrying no size');

  const before = await stack.page
    .locator(`.react-flow__node[data-id="${node.id}"]`)
    .boundingBox();
  const rev = await dragHandle(node.id, 'bottom.right', 160, 100);

  const pinned = await until('the size to reach the server', async () => {
    const found = (await stack.graph()).nodes.find((n: any) => n.id === node.id);
    return found?.size ? found : null;
  });

  // On the grid, and genuinely bigger than the auto size it had.
  assert.equal(pinned.size.w % 15, 0, `w=${pinned.size.w} is off-grid`);
  assert.equal(pinned.size.h % 15, 0, `h=${pinned.size.h} is off-grid`);
  assert.ok(pinned.size.w > 120, `expected a wider box, got ${pinned.size.w}`);

  const after = await stack.page.locator(`.react-flow__node[data-id="${node.id}"]`).boundingBox();
  assert.ok(
    after!.width > before!.width + 40,
    `rendered box did not grow: ${before!.width} -> ${after!.width}`,
  );

  // One gesture, one op — not one per animation frame. And the origin must not move when
  // the bottom-right handle is the one being dragged.
  const feed = await fetch(`${API}/api/changes?since=${rev}&include_layout=true`).then((r) =>
    r.json(),
  );
  assert.deepEqual(
    feed.entries.map((e: any) => e.op.op),
    ['resize_node'],
    'a bottom-right resize is exactly one op, with no move alongside it',
  );
  assert.deepEqual(pinned.position, { x: 0, y: 0 }, 'the origin stayed put');
});

test('a pinned size survives a reload', async () => {
  const node = (await stack.graph()).nodes.find((n: any) => n.data.label === 'Resizable');
  const expected = node.size;
  assert.ok(expected, 'expected the node pinned by the previous test');

  await openCanvas(stack);
  const sel = `.react-flow__node[data-id="${node.id}"]`;
  await until('the node to render again', async () =>
    (await stack.page.locator(sel).count()) > 0,
  );

  const box = await until('the pinned box to be rendered', async () => {
    const measured = await stack.page.locator(sel).evaluate((el) => ({
      w: (el as HTMLElement).offsetWidth,
      h: (el as HTMLElement).offsetHeight,
    }));
    return measured.w === expected.w ? measured : null;
  });
  assert.equal(box.h, expected.h, 'height survived too');
});

// The panel writes to its own diagram, and a resize is no exception.
test('resizing inside the panel writes to the subcanvas, not the parent', async () => {
  const seedIn = await freshDiagram('resize-parent');
  const parent = await seedIn('Has detail', 0, 0);
  await stack.createDiagram('resize-child');
  await stack.op(
    { op: 'add_node_at', label: 'Inner', position: { x: 0, y: 0 } },
    'resize-child',
  );
  await stack.op({ op: 'update_node', id: parent, subcanvas: 'resize-child' });

  await stack.page.locator(`.react-flow__node[data-id="${parent}"] .cp-lens`).click();
  await until('the panel to open', async () =>
    (await stack.page.locator('.lens-panel').count()) > 0,
  );
  const inner = stack.page.locator('.lens-panel .react-flow__node').first();
  await until('the panel node to render', async () => (await inner.count()) > 0);

  const parentBefore = await stack.graph('resize-parent');
  await inner.click();
  const handle = await stack.page
    .locator('.lens-panel .react-flow__resize-control.handle.bottom.right')
    .boundingBox();
  assert.ok(handle, 'no resize handle inside the panel');
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await dragMouse(stack.page, from, { x: from.x + 120, y: from.y + 80 });

  const child = await until('the panel resize to reach its own diagram', async () => {
    const g = await stack.graph('resize-child');
    return g.nodes.some((n: any) => n.size) ? g : null;
  });
  assert.ok(child.nodes[0].size.w > 120);

  const parentAfter = await stack.graph('resize-parent');
  assert.ok(
    parentAfter.nodes.every((n: any) => n.size === undefined),
    'the parent diagram was not touched',
  );
});

// The clamp regression, and the reason it needs its own test: every other resize test grows
// a node to roughly 200px, comfortably under the 320px auto cap, so none of them notices
// `max-width` still applying. Removing the clamp release broke nothing until this existed.
test('a size pinned beyond the auto cap renders at full width', async () => {
  const seedIn = await freshDiagram('resize-wide');
  const id = await seedIn('Wide', 0, 0);
  await stack.op({ op: 'resize_node', id, size: { w: 600, h: 300 } }, 'resize-wide');

  const sel = `.react-flow__node[data-id="${id}"]`;
  const measured = await until('the wide box to render', async () => {
    const m = await stack.page.locator(sel).evaluate((el) => ({
      w: (el as HTMLElement).offsetWidth,
      h: (el as HTMLElement).offsetHeight,
      maxWidth: getComputedStyle(el).maxWidth,
    }));
    return m.w === 600 ? m : null;
  });

  assert.equal(measured.h, 300);
  assert.equal(measured.maxWidth, 'none', 'the auto-sizing cap must be released when pinned');
});

/*
 * A resized node with a body must still read top to bottom.
 *
 * `cp-sized` makes the node a flex container so a pinned box centres its label. With no
 * direction that defaults to `row`, and the label landed *beside* the body instead of above
 * it. Nothing else caught it: the text was all present and correct, just in the wrong place,
 * so only geometry can tell the difference.
 */
test('a resized node keeps its name above its body', async () => {
  const seedIn = await freshDiagram('sized-body');
  const id = await seedIn('Titled', 0, 0);
  await stack.op(
    { op: 'update_node', id, body: 'test again and again\ntest again and again\ntest' },
    'sized-body',
  );
  // Beyond the 420px cap a body would otherwise sit under, so this also proves the pinned
  // width survives — the same trap the 320px label cap set earlier.
  await stack.op({ op: 'resize_node', id, size: { w: 480, h: 300 } }, 'sized-body');

  const node = `.react-flow__node[data-id="${id}"]`;
  await until('the body to render', async () =>
    (await stack.page.locator(`${node} .cp-node-body`).count()) > 0,
  );

  const label = await stack.page.locator(`${node} .cp-node-label`).boundingBox();
  const body = await stack.page.locator(`${node} .cp-node-body`).boundingBox();
  const box = await stack.page.locator(node).boundingBox();
  assert.ok(label && body && box, 'the node, its label and its body must all be measurable');

  assert.ok(
    label.y + label.height <= body.y + 1,
    `the label must sit above the body: label ends at ${label.y + label.height}, body starts at ${body.y}`,
  );
  assert.ok(
    body.width > label.width,
    'the body should fill the pinned width rather than share a row with the label',
  );
  assert.ok(box.width > 420, `the pinned width must survive the body cap, got ${box.width}`);
});

/*
 * Text that outgrows a pinned box grows the box.
 *
 * A pinned size used to be a fixed height, so adding a line to a node you had already sized
 * either clipped it or hid it behind a scrollbar. It is a minimum now: never smaller than
 * you made it, never smaller than its text.
 */
test('a pinned node grows to fit text and never shrinks below its pinned size', async () => {
  const seedIn = await freshDiagram('grow-box');
  const id = await seedIn('Grows', 0, 0);
  await stack.op({ op: 'resize_node', id, size: { w: 300, h: 90 } }, 'grow-box');

  const node = `.react-flow__node[data-id="${id}"]`;
  const heightOf = async () =>
    await stack.page.$eval(node, (el) => (el as HTMLElement).offsetHeight);

  await until('the pinned size to render', async () => (await heightOf()) >= 88);
  const pinned = await heightOf();

  await stack.op(
    { op: 'update_node', id, body: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight' },
    'grow-box',
  );

  const grown = await until('the node to grow past its pinned height', async () => {
    const height = await heightOf();
    return height > pinned + 20 ? height : null;
  });

  // The body has to sit *inside* the box. `scrollHeight` is no use here — the node is
  // `overflow: visible`, so text that does not fit spills out in plain sight rather than
  // being scrolled, and scrollHeight reports padding differences either way.
  const fit = await stack.page.$eval(node, (el) => {
    const box = el as HTMLElement;
    const body = box.querySelector('.cp-node-body') as HTMLElement;
    return { bottom: body.offsetTop + body.offsetHeight, inner: box.clientHeight };
  });
  assert.ok(
    fit.bottom <= fit.inner,
    `the body runs to ${fit.bottom}px inside a ${fit.inner}px box — text is spilling out`,
  );

  // And taking the text away leaves the pinned height standing — a floor, not a fit.
  await stack.op({ op: 'update_node', id, body: '' }, 'grow-box');
  const back = await until('the node to settle back', async () => {
    const height = await heightOf();
    return height < grown - 20 ? height : null;
  });
  assert.ok(back >= pinned - 2, `shrank below the pinned ${pinned}px to ${back}px`);
});
