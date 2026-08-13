import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeOp, kindOf, summarise, type LogEntry } from './changes.js';

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
  assert.equal(
    kindOf({ op: 'add_node_at', label: 'x', position: { x: 0, y: 0 } }),
    'layout',
    'dropping a box on the canvas is a layout act',
  );
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
