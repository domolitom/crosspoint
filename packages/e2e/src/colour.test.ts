import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  API,
  fixtures,
  openCanvas,
  settleViewport,
  startStack,
  until,
  type Stack,
} from './harness.js';

/**
 * Colour, on nodes and on edges.
 *
 * The standard here is stricter than elsewhere: every swatch once rendered as an identical
 * grey pill while every colour assertion passed, because the assertions measured the nodes
 * rather than the buttons. Measure what a human would look at.
 */

let stack: Stack;

before(async () => {
  stack = await startStack();
}, { timeout: 120_000 });

after(async () => {
  await stack?.stop();
});

const { seed, freshDiagram, nodeById } = fixtures(() => stack);

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
/**
 * Edge colour.
 *
 * Asserted on the rendered SVG, not on a proxy. The swatch bug is the cautionary tale here:
 * every colour assertion passed while the UI was visibly wrong, because the assertions
 * measured the wrong element. So these read the `path` stroke and the `marker` that draws
 * the arrowhead — a coloured line ending in a grey arrow would otherwise pass silently.
 */

const edgeById = async (id: string, diagram = 'edge-paint') => {
  const graph = await stack.graph(diagram);
  return graph.edges.find((e: any) => e.id === id);
};

/** The rendered stroke of an edge's path, and the colour of the marker it points with. */
async function edgePaint(id: string) {
  return stack.page.evaluate((edgeId) => {
    const group = document.querySelector(`.react-flow__edge[data-id="${edgeId}"]`);
    const path = group?.querySelector('path.react-flow__edge-path') as SVGPathElement | null;
    if (!path) return null;
    const stroke = getComputedStyle(path).stroke;
    // The arrowhead lives in a <marker> in <defs>, referenced by marker-end: url(#id).
    const ref = path.getAttribute('marker-end') ?? '';
    const markerId = ref.replace(/^url\(["']?#/, '').replace(/["']?\)$/, '');
    const marker = markerId ? document.getElementById(markerId) : null;
    const head = marker?.querySelector('polyline, path') as SVGElement | null;
    return {
      stroke,
      markerStroke: head ? getComputedStyle(head).stroke : null,
      markerFill: head ? getComputedStyle(head).fill : null,
    };
  }, id);
}

/**
 * Seed a fresh node pair joined by an edge.
 *
 * Labels must be unique per call: `seed` looks its node up by label and returns the *first*
 * match, so reusing one silently hands back the previous pair's ids.
 */
async function seedEdge(diagram: string) {
  const seedIn = await freshDiagram(diagram);
  const source = await seedIn('Edge src', 0, 0);
  const target = await seedIn('Edge dst', 0, 200);
  const { status } = await stack.op({ op: 'add_edge', source, target }, diagram);
  assert.equal(status, 200, 'seeding the edge failed');
  return { edge: `${source}->${target}`, source, target, diagram };
}

test('a swatch colours a selected edge, line and arrowhead together', async () => {
  const { edge, diagram } = await seedEdge('edge-paint');
  await until('the edge to render', async () =>
    (await stack.page.locator(`.react-flow__edge[data-id="${edge}"]`).count()) > 0,
  );

  const before = await edgePaint(edge);
  assert.ok(before, 'the edge path did not render');

  /*
   * Retry the click rather than clicking once and waiting for the palette.
   *
   * A click that lands before React Flow has finished fitting the view is discarded, and
   * no amount of waiting afterwards recovers it — this failed one standalone run in three
   * while passing the others. Same fix as the mixed-selection test above.
   */
  const path = `.react-flow__edge[data-id="${edge}"] .react-flow__edge-path`;
  const swatch = stack.page.locator('.swatch[aria-label="red"]');
  await until('the palette to accept an edge selection', async () => {
    await stack.page.locator(path).click({ force: true });
    return !(await swatch.isDisabled());
  });
  await swatch.click();

  const stored = await until('the colour to reach the server', async () => {
    const e = await edgeById(edge);
    return e?.color === 'red' ? e : null;
  });
  assert.equal(stored.color, 'red');

  // Wait for the expected value, not merely for a change: selecting the edge repaints it
  // blue immediately, so "different from the baseline" is true before the colour lands.
  const after = await until('the edge to repaint red', async () => {
    const paint = await edgePaint(edge);
    return paint && paint.stroke === 'rgb(220, 38, 38)' ? paint : null;
  });
  assert.equal(after.stroke, 'rgb(220, 38, 38)', `red stroke should be #dc2626, got ${after.stroke}`);
  // The easy miss: a coloured line with a grey arrow.
  assert.equal(
    after.markerStroke,
    'rgb(220, 38, 38)',
    `the arrowhead must match the line, got ${after.markerStroke}`,
  );
});

// The palette acts on the selection, so a just-coloured edge is selected by definition. If
// selection repainted it, applying a colour would look like it did nothing.
test('a selected coloured edge still shows its own colour', async () => {
  const graph = await stack.graph('edge-paint');
  const edge = graph.edges.find((e: any) => e.color === 'red');
  assert.ok(edge, 'expected the red edge from the previous test');

  const selected = await stack.page.locator(
    `.react-flow__edge[data-id="${edge.id}"].selected`,
  ).count();
  assert.equal(selected, 1, 'the edge should still be selected after colouring');

  const paint = await edgePaint(edge.id);
  assert.equal(paint!.stroke, 'rgb(220, 38, 38)', 'selection must not repaint a coloured edge');
});

test('clearing an edge colour restores the default and removes the key', async () => {
  const graph = await stack.graph('edge-paint');
  const edge = graph.edges.find((e: any) => e.color === 'red');
  assert.ok(edge, 'expected a coloured edge');

  await stack.page.locator('.swatch.swatch-clear').click();
  const cleared = await until('the colour to be cleared', async () => {
    const e = await edgeById(edge.id);
    return e && e.color === undefined ? e : null;
  });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(cleared, 'color'),
    'clearing must delete the key, not store a sentinel',
  );

  // Still selected after clearing, so it falls back to the selection tint rather than the
  // resting grey. Either is the "no colour of its own" state; asserting the wrong one of
  // the two is what a change-based wait would have hidden.
  const paint = await until('the edge to stop being red', async () => {
    const p = await edgePaint(edge.id);
    return p && p.stroke === 'rgb(37, 99, 235)' ? p : null;
  });
  assert.equal(paint.stroke, 'rgb(37, 99, 235)', `selected-uncoloured stroke, got ${paint.stroke}`);
});

test('one swatch click colours a mixed node and edge selection', async () => {
  // Its own diagram, so fitView frames two nodes rather than the twenty this suite has
  // accumulated — zoomed that far out, a node click lands on empty canvas.
  await fetch(`${API}/api/diagrams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'mixed' }),
  });
  const { status } = await stack.op(
    {
      op: 'generate_graph',
      nodes: [{ label: 'Mixed src' }, { label: 'Mixed dst' }],
      edges: [{ source: 'mixed-src', target: 'mixed-dst' }],
      replace: true,
    },
    'mixed',
  );
  assert.equal(status, 200, 'seeding the mixed diagram');

  await openCanvas(stack);
  const switcher = stack.page.locator('.diagram-switcher');
  await until('the switcher to offer the mixed diagram', async () =>
    (await switcher.locator('option[value="mixed"]').count()) > 0,
  );
  await switcher.selectOption('mixed');
  await settleViewport(stack.page);
  await until('the mixed diagram to render', async () =>
    (await stack.page.locator('.react-flow__node').count()) === 2,
  );

  const edge = 'mixed-src->mixed-dst';
  /*
   * Retry the pair of clicks rather than firing them once and waiting.
   *
   * A single attempt is load-sensitive: under a full-suite run a click can land before
   * React Flow has finished mounting and fitting the view, and then no amount of waiting
   * recovers it — the click is simply gone. This failed once in a full run while passing
   * standalone. Re-clicking is faithful to what the test is about, which is that one swatch
   * colours a mixed selection, not that a single click always registers.
   */
  await until('both a node and an edge to be selected', async () => {
    await stack.page.locator('.react-flow__node[data-id="mixed-src"]').click();
    await stack.page
      .locator(`.react-flow__edge[data-id="${edge}"] .react-flow__edge-path`)
      // React Flow's multi-selection key is Meta on macOS and Control everywhere else, so a
      // hardcoded Meta selects nothing on Linux and the wait below can never come true.
      .click({ modifiers: ['ControlOrMeta'], force: true });
    const n = await stack.page.locator('.react-flow__node.selected').count();
    const e = await stack.page.locator('.react-flow__edge.selected').count();
    return n === 1 && e === 1;
  });

  const swatch = stack.page.locator('.swatch[aria-label="green"]');
  await until('the palette to be usable', async () => !(await swatch.isDisabled()));
  await swatch.click();

  const both = await until('both to reach the server coloured', async () => {
    const g = await stack.graph('mixed');
    const n = g.nodes.find((x: any) => x.id === 'mixed-src');
    const e = g.edges.find((x: any) => x.id === edge);
    return n?.data?.color === 'green' && e?.color === 'green' ? { n, e } : null;
  });
  assert.equal(both.n.data.color, 'green');
  assert.equal(both.e.color, 'green');

  // Wait for the repaint rather than asserting straight after the server confirms: the
  // push and the re-render are separate steps, and reading between them is a race.
  const paint = await until('the edge to repaint green', async () => {
    const p = await edgePaint(edge);
    return p && p.stroke === 'rgb(22, 163, 74)' ? p : null;
  });
  assert.equal(paint.stroke, 'rgb(22, 163, 74)', 'green stroke should be #16a34a');
});
