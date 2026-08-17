import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeOp, kindOf, summarise, withoutLayout, type LogEntry } from './changes.js';

const entry = (rev: number, op: LogEntry['op']): LogEntry => ({
  rev,
  ts: '2026-08-13T20:14:02.113Z',
  kind: kindOf(op),
  diagram: 'plan',
  op,
});

test('ops are tagged structural, layout or external', () => {
  assert.equal(kindOf({ op: 'add_node', label: 'retry' }), 'structural');
  assert.equal(kindOf({ op: 'delete_edge', id: 'a->b' }), 'structural');
  assert.equal(kindOf({ op: 'move_node', id: 'a', position: { x: 0, y: 0 } }), 'layout');
  // Structural despite carrying a coordinate: it brings a node into existence, and that is
  // always part of the message. Tagging it `layout` — which fell out of deriving `kindOf`
  // from `isLayoutOp` — meant a box dragged from the palette was filtered out of the feed
  // as noise and never reached a reader at all.
  assert.equal(
    kindOf({ op: 'add_node_at', label: 'x', position: { x: 0, y: 0 } }),
    'structural',
    'dropping a box creates something, so it belongs in the feed',
  );
  assert.equal(kindOf({ op: 'align', ids: ['a', 'b'], edge: 'left' }), 'layout');
  assert.equal(kindOf({ op: 'distribute', ids: ['a', 'b'], axis: 'horizontal' }), 'layout');
  assert.equal(kindOf({ op: 'external_edit' }), 'external');
});

// The tag exists so a consumer can drop layout noise in one filter.
test('layout entries are separable from the rest with a single filter', () => {
  const entries = [
    entry(1, { op: 'add_node', label: 'retry' }),
    entry(2, { op: 'move_node', id: 'retry', position: { x: 15, y: 30 } }),
    entry(3, { op: 'add_edge', source: 'fetch', target: 'retry' }),
    entry(4, { op: 'external_edit' }),
  ];
  const kept = entries.filter((e) => e.kind !== 'layout');
  assert.deepEqual(kept.map((e) => e.rev), [1, 3, 4], 'external survives, layout does not');
});

test('every op renders to a readable line', () => {
  assert.equal(describeOp({ op: 'add_node', label: 'retry' }), '+ node "retry"');
  assert.equal(
    describeOp({ op: 'add_node', label: 'retry', near: 'fetch' }),
    '+ node "retry" near fetch',
  );
  assert.equal(
    describeOp({ op: 'add_edge', source: 'fetch', target: 'retry' }),
    '+ edge fetch → retry',
  );
  assert.equal(
    describeOp({ op: 'add_edge', source: 'a', target: 'b', label: 'reads' }),
    '+ edge a → b "reads"',
  );
  assert.equal(
    describeOp({ op: 'reconnect_edge', id: 'a->b', source: 'a', target: 'c' }),
    '~ edge a->b now a → c',
  );
  assert.equal(
    describeOp({ op: 'update_node', id: 'auth', label: 'Auth API' }),
    '~ node auth relabelled "Auth API"',
  );
  assert.equal(describeOp({ op: 'delete_node', id: 'auth' }), '− node auth');
  assert.equal(describeOp({ op: 'delete_edge', id: 'a->b' }), '− edge a->b');
  assert.equal(
    describeOp({ op: 'move_node', id: 'auth', position: { x: 0, y: 0 } }),
    'moved auth',
  );
  assert.equal(
    describeOp({ op: 'external_edit' }),
    'graph file edited outside the server',
  );
});

test('a move renders without leaking coordinates into the summary', () => {
  const line = describeOp({ op: 'move_node', id: 'auth', position: { x: 342, y: 118 } });
  assert.ok(!line.includes('342'), 'pixel values are noise in a change summary');
});

test('the summary is flat and chronological, tagged by diagram', () => {
  const text = summarise([
    entry(13, { op: 'add_node', label: 'retry' }),
    { ...entry(15, { op: 'add_node', label: 'backoff' }), diagram: 'step-2-impl' },
    entry(17, { op: 'delete_edge', id: 'fetch->cache' }),
  ]);

  assert.deepEqual(text.split('\n').map((l) => l.trim()), [
    '13  plan  + node "retry"',
    '15  step-2-impl  + node "backoff"',
    '17  plan  − edge fetch->cache',
  ]);
});

test('an empty feed says so rather than rendering nothing', () => {
  assert.equal(summarise([]), 'No changes.');
});

test('a colour change reads as a colour change', () => {
  assert.equal(
    describeOp({ op: 'update_node', id: 'parse', color: 'amber' }),
    '~ node parse coloured amber',
  );
  assert.equal(
    describeOp({ op: 'update_node', id: 'parse', color: 'none' }),
    '~ node parse colour cleared',
  );
  assert.equal(
    describeOp({ op: 'add_node', label: 'Broken step', color: 'red' }),
    '+ node "Broken step" coloured red',
  );
});

test('one op carrying label and colour names both', () => {
  assert.equal(
    describeOp({ op: 'update_node', id: 'parse', label: 'Parse input', color: 'green' }),
    '~ node parse relabelled "Parse input", coloured green',
  );
});

// Colour must survive the filter, or colouring a node red to say something would be
// dropped as noise before it ever reached a reader.
test('withoutLayout keeps a colour change', () => {
  const feed = [
    entry(1, { op: 'update_node', id: 'parse', color: 'red' }),
    entry(2, { op: 'move_node', id: 'parse', position: { x: 0, y: 0 } }),
  ];
  assert.deepEqual(withoutLayout(feed).map((e) => e.rev), [1]);
});

test('withoutLayout keeps the message and drops the repositioning', () => {
  const feed = [
    entry(1, { op: 'add_node', label: 'retry' }),
    entry(2, { op: 'move_node', id: 'retry', position: { x: 15, y: 30 } }),
    entry(3, { op: 'add_edge', source: 'fetch', target: 'retry' }),
    entry(4, { op: 'move_node', id: 'fetch', position: { x: 0, y: 0 } }),
    entry(5, { op: 'external_edit' }),
  ];

  assert.deepEqual(withoutLayout(feed).map((e) => e.rev), [1, 3, 5]);
});

// The ratio that made this the default rather than an option.
test('withoutLayout rescues a feed that is mostly moves', () => {
  const feed: LogEntry[] = [];
  for (let i = 1; i <= 18; i++) {
    feed.push(entry(i, { op: 'move_node', id: `n${i}`, position: { x: i, y: i } }));
  }
  feed.push(entry(19, { op: 'add_edge', source: 'a', target: 'b' }));
  feed.push(entry(20, { op: 'delete_edge', id: 'c->d' }));

  const kept = withoutLayout(feed);
  assert.equal(feed.length, 20);
  assert.equal(kept.length, 2, '90% of that feed was noise');
  assert.ok(kept.every((e) => e.kind === 'structural'));
});

test('an edge colour change reads as a colour change', () => {
  assert.equal(
    describeOp({ op: 'update_edge', id: 'a->b', color: 'red' }),
    '~ edge a->b coloured red',
  );
  assert.equal(
    describeOp({ op: 'update_edge', id: 'a->b', color: 'none' }),
    '~ edge a->b colour cleared',
  );
  assert.equal(
    describeOp({ op: 'update_edge', id: 'a->b', label: 'reads', color: 'green' }),
    '~ edge a->b labelled "reads", coloured green',
  );
  assert.equal(
    describeOp({ op: 'add_edge', source: 'a', target: 'b', color: 'blue' }),
    '+ edge a → b coloured blue',
  );
});

// A coloured edge is a statement, so it must survive the filter that drops repositioning.
test('withoutLayout keeps an edge colour change', () => {
  const feed = [
    entry(1, { op: 'update_edge', id: 'a->b', color: 'red' }),
    entry(2, { op: 'move_node', id: 'a', position: { x: 0, y: 0 } }),
  ];
  assert.deepEqual(withoutLayout(feed).map((e) => e.rev), [1]);
  assert.equal(kindOf({ op: 'update_edge', id: 'a->b', color: 'red' }), 'structural');
});
