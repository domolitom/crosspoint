import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  API,
  fixtures,
  openCanvas,
  startStack,
  until,
  type Stack,
} from './harness.js';

/**
 * Inline text: creating a node by name, renaming one, editing an edge label, and the label
 * a node sizes itself from.
 *
 * `window.prompt` is banned in this canvas — it blocks the page and the user rejected it
 * outright — so every one of these is an inline input, and each has its own way to go wrong.
 */

let stack: Stack;

before(async () => {
  stack = await startStack();
}, { timeout: 120_000 });

after(async () => {
  await stack?.stop();
});

const { seed, freshDiagram, awaitFocus } = fixtures(() => stack);

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
/**
 * Creating and renaming, inline.
 *
 * The palette drag this replaces was the one interaction the suite could not drive
 * natively — HTML5 `dataTransfer` exists only on real drag events — so removing it also
 * removes the only synthetic-event caveat here. Double-click is real mouse input.
 */

/** Double-click the pane at a fraction across it, and return the screen point used. */
async function doubleClickPane(fx: number, fy: number, root = '.react-flow__pane') {
  const pane = await stack.page.locator(root).first().boundingBox();
  assert.ok(pane, 'the pane has no bounding box');
  const point = { x: pane.x + pane.width * fx, y: pane.y + pane.height * fy };
  await stack.page.mouse.dblclick(point.x, point.y);
  return point;
}

test('double-clicking empty canvas creates a node there, with one op', async () => {
  await freshDiagram('create-inline');
  const before = await stack.graph('create-inline');
  const zoomBefore = await stack.page.evaluate(
    () => getComputedStyle(document.querySelector('.react-flow__viewport')!).transform,
  );

  const point = await doubleClickPane(0.62, 0.4);
  const input = stack.page.locator('.cp-node-input');
  await until('the draft input to appear', async () => (await input.count()) > 0);

  // Double-click creates; it must not also zoom, or the point drifts under the caret.
  assert.equal(
    await stack.page.evaluate(
      () => getComputedStyle(document.querySelector('.react-flow__viewport')!).transform,
    ),
    zoomBefore,
    'double-clicking the pane must not zoom the canvas',
  );

  await input.fill('Typed inline');
  await stack.page.keyboard.press('Enter');

  const created = await until('the node to reach the server', async () => {
    const g = await stack.graph('create-inline');
    return g.nodes.find((n: any) => n.data.label === 'Typed inline') ?? null;
  });
  const after = await stack.graph('create-inline');
  assert.equal(after.nodes.length, before.nodes.length + 1, 'exactly one node was added');

  // One op, not a create followed by a rename.
  const feed = await (await fetch(`${API}/api/changes?since=${before.rev}`)).json();
  const ops = feed.entries.map((e: any) => e.op.op);
  assert.deepEqual(ops, ['add_node_at'], `expected a single add_node_at, got ${ops.join(', ')}`);

  const expected = await stack.page.evaluate((pt) => {
    const el = document.querySelector('.react-flow__viewport') as HTMLElement;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    const pane = document.querySelector('.react-flow__pane')!.getBoundingClientRect();
    return { x: (pt.x - pane.left - m.e) / m.a, y: (pt.y - pane.top - m.f) / m.d };
  }, point);
  assert.ok(
    Math.abs(created.position.x - expected.x) < 40 &&
      Math.abs(created.position.y - expected.y) < 40,
    `node landed at ${JSON.stringify(created.position)}, expected near ${JSON.stringify(expected)}`,
  );
});

test('Escape during a draft leaves the graph and the rev untouched', async () => {
  const before = await stack.graph('create-inline');

  await doubleClickPane(0.3, 0.7);
  const input = stack.page.locator('.cp-node-input');
  await until('the draft input to appear', async () => (await input.count()) > 0);
  await input.fill('Never created');
  await stack.page.keyboard.press('Escape');

  await until('the draft to disappear', async () => (await input.count()) === 0);
  const after = await stack.graph('create-inline');
  assert.equal(after.rev, before.rev, 'an abandoned draft must not touch the server');
  assert.equal(after.nodes.length, before.nodes.length);
});

test('a node renames inline, and an unchanged label emits no op', async () => {
  const seedIn = await freshDiagram('rename-inline');
  const id = await seedIn('Rename me', 0, 0);
  const node = stack.page.locator(`.react-flow__node[data-id="${id}"]`);
  const input = stack.page.locator(`.react-flow__node[data-id="${id}"] .cp-node-input`);
  const labelOf = async () =>
    (await stack.graph('rename-inline')).nodes.find((n: any) => n.id === id)?.data?.label;

  await node.dblclick();
  await until('the rename input to appear', async () => (await input.count()) > 0);
  await input.fill('Renamed inline');
  await stack.page.keyboard.press('Enter');
  await until('the rename to reach the server', async () => (await labelOf()) === 'Renamed inline');

  // Escape reverts.
  await node.dblclick();
  await until('the input to reappear', async () => (await input.count()) > 0);
  await input.fill('Discarded');
  // Click into the field before the key: `fill` alone has proved unreliable at holding
  // focus here, and a key sent to the wrong element makes this look like a product bug.
  await input.click();
  await stack.page.keyboard.press('Escape');
  await until('the input to close', async () => (await input.count()) === 0);
  assert.equal(await labelOf(), 'Renamed inline', 'Escape must revert');

  // An unchanged label is not a change.
  const before = (await stack.graph('rename-inline')).rev;
  await node.dblclick();
  await until('the input to reappear', async () => (await input.count()) > 0);
  await input.click();
  await stack.page.keyboard.press('Enter');
  await until('the input to close', async () => (await input.count()) === 0);
  assert.equal(
    (await stack.graph('rename-inline')).rev,
    before,
    'an unchanged label must emit no op',
  );
});

// React Flow deletes the selection on Backspace. If the inline input let the key through,
// typing a label would destroy the node being renamed — silently, with no error surface.
test('Backspace inside the rename input does not delete the node', async () => {
  const seedIn = await freshDiagram('rename-keys');
  const id = await seedIn('Keep me', 0, 0);
  const input = stack.page.locator(`.react-flow__node[data-id="${id}"] .cp-node-input`);

  await stack.page.locator(`.react-flow__node[data-id="${id}"]`).click();
  await stack.page.locator(`.react-flow__node[data-id="${id}"]`).dblclick();
  await until('the rename input to appear', async () => (await input.count()) > 0);

  await input.fill('x');
  await stack.page.keyboard.press('Backspace');
  await stack.page.keyboard.press('Backspace');
  await stack.page.keyboard.press('Escape');
  await until('the input to close', async () => (await input.count()) === 0);

  const still = (await stack.graph('rename-keys')).nodes.find((n: any) => n.id === id);
  assert.ok(still, 'Backspace in the input deleted the node');
  assert.equal(still.data.label, 'Keep me', 'and the label is untouched');
});
/**
 * Editing edge text.
 *
 * Edges have carried a `label` since the beginning, but until now only an agent could set
 * one — there was no `onEdgeDoubleClick` and no editing UI, so a human could see a label
 * and never write one.
 */
test('double-clicking an edge edits its label in place', async () => {
  const seedIn = await freshDiagram('edge-label');
  const src = await seedIn('From', 0, 0);
  const dst = await seedIn('To', 0, 240);
  await stack.op({ op: 'add_edge', source: src, target: dst }, 'edge-label');
  const edgeId = `${src}->${dst}`;

  const path = `.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`;
  await until('the edge to render', async () => (await stack.page.locator(path).count()) > 0);

  await stack.page.locator(path).dblclick({ force: true });
  await stack.page.waitForSelector('.cp-edge-input');
  await awaitFocus('.cp-edge-input');
  await stack.page.keyboard.type('reads from');
  await stack.page.keyboard.press('Enter');

  const labelled = await until('the label to reach the server', async () => {
    const edge = (await stack.graph('edge-label')).edges.find((e: any) => e.id === edgeId);
    return edge?.label ? edge : null;
  });
  assert.equal(labelled.label, 'reads from');
});

// Clearing must remove the key, not store "", matching how colour and subcanvas clear.
test('emptying an edge label removes it rather than storing an empty string', async () => {
  const edges = (await stack.graph('edge-label')).edges;
  const edgeId = edges.find((e: any) => e.label === 'reads from')?.id;
  assert.ok(edgeId, 'expected the labelled edge from the previous test');

  // Dispatched rather than clicked: a labelled, selected edge has its × sitting over the
  // path midpoint, so a positional double-click lands on delete instead. The test above
  // already proves the edge is hittable; this one is about what clearing does.
  const path = `.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`;
  await stack.page.locator(path).dispatchEvent('dblclick');
  await stack.page.waitForSelector('.cp-edge-input');
  await awaitFocus('.cp-edge-input');
  await stack.page.keyboard.press('ControlOrMeta+a');
  await stack.page.keyboard.press('Backspace');
  await stack.page.keyboard.press('Enter');

  const cleared = await until('the label to be gone', async () => {
    const edge = (await stack.graph('edge-label')).edges.find((e: any) => e.id === edgeId);
    return edge && !('label' in edge) ? edge : null;
  });
  assert.ok(!('label' in cleared), 'the key is absent, not empty');
});

test('double-clicking an edge does not also create a node', async () => {
  const before = (await stack.graph('edge-label')).nodes.length;
  await stack.page.locator('.react-flow__edge .react-flow__edge-path').first().dblclick({ force: true });
  await stack.page.waitForTimeout(400);
  await stack.page.keyboard.press('Escape');
  assert.equal(
    (await stack.graph('edge-label')).nodes.length,
    before,
    'the pane double-click handler must not fire for an edge',
  );
});
