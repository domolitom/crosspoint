import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  API,
  fixtures,
  settleViewport,
  startStack,
  until,
  type Stack,
} from './harness.js';

/**
 * Undo and redo from the keyboard.
 *
 * The graph assertions go through the API, because the point is that the *server* stepped
 * back — a canvas that merely looks right would be the bug. The keyboard cases are the
 * fragile part: Cmd+Z inside a text field must be the browser's own text undo, and with a
 * panel open it must step the panel's diagram rather than the one behind it.
 */

let stack: Stack;

before(async () => {
  stack = await startStack();
}, { timeout: 120_000 });

after(async () => {
  await stack?.stop();
});

const { freshDiagram, awaitFocus } = fixtures(() => stack);

test('Cmd+Z removes a node that was just added', async () => {
  const seedIn = await freshDiagram('undo-basic');
  await seedIn('Kept', 0, 0);
  await seedIn('Doomed', 0, 200);
  await settleViewport(stack.page);

  assert.equal((await stack.graph('undo-basic')).nodes.length, 2);

  await stack.page.keyboard.press('ControlOrMeta+z');

  const after = await until('the node to be gone from the server', async () => {
    const g = await stack.graph('undo-basic');
    return g.nodes.length === 1 ? g : null;
  });
  assert.deepEqual(after.nodes.map((n: any) => n.data.label), ['Kept']);
});

test('Cmd+Shift+Z brings it back', async () => {
  await stack.page.keyboard.press('ControlOrMeta+Shift+z');
  const after = await until('the node to return', async () => {
    const g = await stack.graph('undo-basic');
    return g.nodes.length === 2 ? g : null;
  });
  assert.ok(after.nodes.some((n: any) => n.data.label === 'Doomed'));
});

// Snapshots, so this has to be exact rather than approximately right.
test('Cmd+Z after a drag restores the precise position', async () => {
  const node = (await stack.graph('undo-basic')).nodes.find((n: any) => n.data.label === 'Kept');
  await stack.op({ op: 'move_node', id: node.id, position: { x: 615, y: 450 } }, 'undo-basic');
  await until('the first move to land', async () => {
    const n = (await stack.graph('undo-basic')).nodes.find((x: any) => x.id === node.id);
    return n.position.x === 615;
  });

  await stack.op({ op: 'move_node', id: node.id, position: { x: 30, y: 45 } }, 'undo-basic');
  await until('the second move to land', async () => {
    const n = (await stack.graph('undo-basic')).nodes.find((x: any) => x.id === node.id);
    return n.position.x === 30;
  });

  await stack.page.keyboard.press('ControlOrMeta+z');

  const restored = await until('the position to be restored', async () => {
    const n = (await stack.graph('undo-basic')).nodes.find((x: any) => x.id === node.id);
    return n.position.x === 615 ? n : null;
  });
  assert.deepEqual(restored.position, { x: 615, y: 450 }, 'exactly where it was, not near it');
});

/*
 * The destructive case. Mid-rename, the node being renamed is precisely what an errant
 * graph-undo would delete — so this asserts the graph did NOT move while the field is open.
 */
test('Cmd+Z while renaming edits the text and leaves the graph alone', async () => {
  const before = await stack.graph('undo-basic');
  const target = before.nodes[0];

  await stack.page.locator(`.react-flow__node[data-id="${target.id}"]`).dblclick();
  await stack.page.waitForSelector('.cp-node-input');
  await awaitFocus('.cp-node-input');
  await stack.page.keyboard.type('ZZ');
  await stack.page.keyboard.press('ControlOrMeta+z');
  await stack.page.waitForTimeout(300);

  assert.equal(
    await stack.page.locator('.cp-node-input').count(),
    1,
    'still editing — the keystroke belonged to the field',
  );
  const after = await stack.graph('undo-basic');
  assert.equal(after.rev, before.rev, 'the graph did not step back');
  assert.equal(after.nodes.length, before.nodes.length);

  await stack.page.keyboard.press('Escape');
});

test('with a panel open, Cmd+Z steps the panel diagram and not the parent', async () => {
  const seedIn = await freshDiagram('undo-parent');
  const parent = await seedIn('Undo parent', 0, 0);
  await stack.createDiagram('undo-child');
  await stack.op(
    {
      op: 'generate_graph',
      nodes: [{ label: 'Child one' }, { label: 'Child two' }],
      edges: [{ source: 'child-one', target: 'child-two' }],
      replace: true,
    },
    'undo-child',
  );
  await stack.op({ op: 'update_node', id: parent, subcanvas: 'undo-child' }, 'undo-parent');

  await until('the lens badge', async () =>
    (await stack.page.locator(`.react-flow__node[data-id="${parent}"] .cp-lens`).count()) > 0,
  );
  await stack.page.locator(`.react-flow__node[data-id="${parent}"] .cp-lens`).click();
  await stack.page.waitForSelector('.lens-panel');

  await stack.op({ op: 'add_node', label: 'Child three' }, 'undo-child');
  await until('the child to have three', async () =>
    (await stack.graph('undo-child')).nodes.length === 3,
  );
  const parentBefore = (await stack.graph('undo-parent')).nodes.map((n: any) => n.id).join(',');

  await stack.page.keyboard.press('ControlOrMeta+z');

  await until('the child to step back', async () =>
    (await stack.graph('undo-child')).nodes.length === 2,
  );
  assert.equal(
    (await stack.graph('undo-parent')).nodes.map((n: any) => n.id).join(','),
    parentBefore,
    'the diagram behind the panel must be untouched',
  );
});
