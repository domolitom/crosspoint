import assert from 'node:assert/strict';
import { test } from 'node:test';

import { kindOf, withoutLayout, type LogEntry } from './changes.js';
import { GraphError } from './errors.js';
import { applyOp } from './ops.js';
import { estimateNodeHeight, estimateNodeWidth, GRID } from './placement.js';
import { isLayoutOp, type Graph, type GraphOp } from './types.js';

/**
 * Semantic layout ops: the escape hatch that lets an agent tidy without naming a pixel.
 *
 * The claim under test is not just "the maths is right" but that only the named nodes move.
 * A tidy that shifts the twelve nodes you did not mention is worse than no tidy at all.
 */

const at = (id: string, x: number, y: number, label = id): Graph['nodes'][number] => ({
  id,
  position: { x, y },
  data: { label },
});

const graphOf = (...nodes: Graph['nodes']): Graph => ({ rev: 0, nodes, edges: [] });

const posOf = (graph: Graph, id: string) => graph.nodes.find((n) => n.id === id)!.position!;
const width = (label: string) => estimateNodeWidth(label);
const height = (label: string) => estimateNodeHeight(label);

test('aligning on each edge lines the group up', () => {
  const base = graphOf(at('a', 0, 0), at('b', 150, 300), at('c', 75, 600));

  const left = applyOp(base, { op: 'align', ids: ['a', 'b', 'c'], edge: 'left' });
  assert.deepEqual(
    ['a', 'b', 'c'].map((id) => posOf(left, id).x),
    [0, 0, 0],
    'left edges share the leftmost x',
  );

  const top = applyOp(base, { op: 'align', ids: ['a', 'b', 'c'], edge: 'top' });
  assert.deepEqual(
    ['a', 'b', 'c'].map((id) => posOf(top, id).y),
    [0, 0, 0],
  );

  // Same-width labels here, so right edges coincide when the x values do.
  const right = applyOp(base, { op: 'align', ids: ['a', 'b', 'c'], edge: 'right' });
  const rights = ['a', 'b', 'c'].map((id) => posOf(right, id).x + width(id));
  assert.equal(new Set(rights).size, 1, `right edges should coincide, got ${rights}`);

  const bottom = applyOp(base, { op: 'align', ids: ['a', 'b', 'c'], edge: 'bottom' });
  const bottoms = ['a', 'b', 'c'].map((id) => posOf(bottom, id).y + height(id));
  assert.equal(new Set(bottoms).size, 1, `bottom edges should coincide, got ${bottoms}`);
});

// The reason alignment needs real sizes: a wide box and a narrow one centred against one
// shared constant end up with neither centre where it belongs.
test('centre alignment is correct for differently-sized nodes', () => {
  const wide = 'An extremely long label that pushes this node to the maximum width';
  const base = graphOf(at('narrow', 0, 0, 'A'), at('wide', 500, 200, wide));

  const centred = applyOp(base, { op: 'align', ids: ['narrow', 'wide'], edge: 'center-x' });
  const centreOf = (id: string, label: string) => posOf(centred, id).x + width(label) / 2;

  const a = centreOf('narrow', 'A');
  const b = centreOf('wide', wide);
  assert.ok(
    Math.abs(a - b) <= GRID,
    `centres should coincide within one grid step: ${a} vs ${b}`,
  );
  assert.notEqual(
    posOf(centred, 'narrow').x,
    posOf(centred, 'wide').x,
    'and they must NOT share a left edge, which is what a shared-width bug would produce',
  );
});

test('centre-y aligns vertical centres, not tops', () => {
  const tall = 'A really quite long node label that will certainly wrap onto several lines';
  const base = graphOf(at('short', 0, 0, 'A'), at('tall', 0, 400, tall));

  const centred = applyOp(base, { op: 'align', ids: ['short', 'tall'], edge: 'center-y' });
  const a = posOf(centred, 'short').y + height('A') / 2;
  const b = posOf(centred, 'tall').y + height(tall) / 2;
  assert.ok(Math.abs(a - b) <= GRID, `vertical centres should coincide: ${a} vs ${b}`);
});

test('distribute produces even gaps between boxes', () => {
  const base = graphOf(at('a', 0, 0), at('b', 100, 0), at('c', 200, 0), at('d', 900, 0));

  const spread = applyOp(base, {
    op: 'distribute',
    ids: ['a', 'b', 'c', 'd'],
    axis: 'horizontal',
  });

  const order = ['a', 'b', 'c', 'd'];
  const gaps: number[] = [];
  for (let i = 1; i < order.length; i++) {
    const prev = posOf(spread, order[i - 1]).x + width(order[i - 1]);
    gaps.push(posOf(spread, order[i]).x - prev);
  }
  // Snapping to the grid perturbs perfectly even gaps by at most one step.
  const spreadOfGaps = Math.max(...gaps) - Math.min(...gaps);
  assert.ok(spreadOfGaps <= GRID, `gaps should be even within a grid step, got ${gaps}`);
});

test('distribute leaves the outermost nodes where they were', () => {
  const base = graphOf(at('a', 0, 0), at('b', 100, 0), at('c', 600, 0));
  const spread = applyOp(base, { op: 'distribute', ids: ['a', 'b', 'c'], axis: 'horizontal' });

  assert.equal(posOf(spread, 'a').x, 0, 'the first node anchors the span');
  assert.equal(posOf(spread, 'c').x, 600, 'and so does the last');
});

test('distribute works vertically too', () => {
  const base = graphOf(at('a', 0, 0), at('b', 0, 50), at('c', 0, 600));
  const spread = applyOp(base, { op: 'distribute', ids: ['a', 'b', 'c'], axis: 'vertical' });

  const ys = ['a', 'b', 'c'].map((id) => posOf(spread, id).y);
  assert.deepEqual(ys, [...ys].sort((p, q) => p - q), 'order is preserved');
  assert.ok(ys[1] > ys[0] && ys[1] < ys[2], 'the middle node moved between the outer two');
});

// The one that matters most: tidying three nodes must not disturb the other twelve.
test('nodes not named in ids do not move', () => {
  let base = graphOf();
  for (let i = 0; i < 15; i++) {
    base = { ...base, nodes: [...base.nodes, at(`n${i}`, i * 37, i * 53)] };
  }
  const before = new Map(base.nodes.map((n) => [n.id, { ...n.position! }]));

  const aligned = applyOp(base, { op: 'align', ids: ['n0', 'n1', 'n2'], edge: 'left' });

  for (const node of aligned.nodes) {
    if (['n0', 'n1', 'n2'].includes(node.id)) continue;
    assert.deepEqual(
      node.position,
      before.get(node.id),
      `${node.id} was not named in the op and must not have moved`,
    );
  }
  assert.equal(aligned.nodes.length, 15, 'and nothing appeared or vanished');
});

test('aligned positions land on the grid', () => {
  const base = graphOf(at('a', 7, 11), at('b', 143, 298));
  const aligned = applyOp(base, { op: 'align', ids: ['a', 'b'], edge: 'center-x' });

  for (const node of aligned.nodes) {
    assert.equal(node.position!.x % GRID, 0, `${node.id} x off-grid: ${node.position!.x}`);
    assert.equal(node.position!.y % GRID, 0, `${node.id} y off-grid: ${node.position!.y}`);
  }
});

test('unknown, duplicate and too-few ids are all refused', () => {
  const base = graphOf(at('a', 0, 0), at('b', 100, 0));

  assert.throws(
    () => applyOp(base, { op: 'align', ids: ['a', 'ghost'], edge: 'left' }),
    GraphError,
    'unknown id',
  );
  assert.throws(
    () => applyOp(base, { op: 'align', ids: ['a', 'a'], edge: 'left' }),
    GraphError,
    'duplicate id',
  );
  // Aligning one node means nothing, so it is far likelier to be a mistake than intent.
  assert.throws(
    () => applyOp(base, { op: 'align', ids: ['a'], edge: 'left' }),
    GraphError,
    'one id',
  );
  assert.throws(
    () => applyOp(base, { op: 'distribute', ids: [], axis: 'horizontal' }),
    GraphError,
    'no ids',
  );
});

test('each op costs exactly one rev', () => {
  // Generously spaced: a span that cannot hold the boxes is refused, so a cramped fixture
  // would be testing the guard rather than the rev counter.
  const base = graphOf(at('a', 0, 0), at('b', 400, 300), at('c', 900, 900));

  const aligned = applyOp(base, { op: 'align', ids: ['a', 'b', 'c'], edge: 'top' });
  assert.equal(aligned.rev, base.rev + 1);

  const spread = applyOp(aligned, {
    op: 'distribute',
    ids: ['a', 'b', 'c'],
    axis: 'horizontal',
  });
  assert.equal(spread.rev, aligned.rev + 1);
});

/**
 * The two halves of the design, asserted together on purpose.
 *
 * Getting one right and the other wrong is the likely failure, and neither would look wrong
 * on its own: an `align` that is barred from the agent surface is useless, and one that
 * shows up in the change feed buries the message it was supposed to leave alone.
 */
test('align is issuable by an agent yet filtered from the feed', () => {
  const op: GraphOp = { op: 'align', ids: ['a', 'b'], edge: 'left' };

  assert.equal(
    isLayoutOp(op),
    false,
    'carries no coordinate, so it must NOT be gated off the agent write surface',
  );
  assert.equal(kindOf(op), 'layout', 'but it only moves boxes, so the feed calls it noise');

  const entry: LogEntry = { rev: 1, ts: 'x', kind: kindOf(op), diagram: 'plan', op };
  assert.deepEqual(withoutLayout([entry]), [], 'and the default feed drops it');
});

test('distribute makes the same pair of claims', () => {
  const op: GraphOp = { op: 'distribute', ids: ['a', 'b'], axis: 'horizontal' };
  assert.equal(isLayoutOp(op), false);
  assert.equal(kindOf(op), 'layout');
});

// The mirror image, and the bug that came from conflating the two predicates.
test('add_node_at is barred from the agent surface but stays in the feed', () => {
  const op: GraphOp = { op: 'add_node_at', label: 'Retry', position: { x: 0, y: 0 } };
  assert.equal(isLayoutOp(op), true, 'it names a coordinate, so an agent may not issue it');
  assert.equal(kindOf(op), 'structural', 'but it creates a node, which is always the message');

  const entry: LogEntry = { rev: 1, ts: 'x', kind: kindOf(op), diagram: 'plan', op };
  assert.equal(withoutLayout([entry]).length, 1, 'so the default feed keeps it');
});

// A span smaller than the boxes it must hold has no solution: the endpoints are anchors, so
// the only alternatives are overlapping them or moving an anchor. Silently succeeding while
// changing nothing is the failure mode this refusal exists to prevent.
test('distributing into a span too small to hold the nodes is refused', () => {
  const base = graphOf(at('a', 0, 0), at('b', 0, 20), at('c', 0, 40));

  assert.throws(
    () => applyOp(base, { op: 'distribute', ids: ['a', 'b', 'c'], axis: 'vertical' }),
    (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.match((err as Error).message, /only \d+px apart/);
      return true;
    },
  );
});

test('distributing into a span that does fit succeeds', () => {
  const base = graphOf(at('a', 0, 0), at('b', 0, 100), at('c', 0, 600));
  const spread = applyOp(base, { op: 'distribute', ids: ['a', 'b', 'c'], axis: 'vertical' });
  assert.equal(posOf(spread, 'a').y, 0);
  assert.equal(posOf(spread, 'c').y, 600);
});
