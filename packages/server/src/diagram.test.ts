import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiagramFile } from './diagram.js';

/**
 * Telling our own writes from someone else's.
 *
 * `persistNow` records `lastWritten` before the rename lands, so for the length of that
 * write the file still holds the previous text — ours, but no longer the text
 * `lastWritten` compares against. Reading it back as an external edit reverted the diagram
 * and pushed a phantom step onto undo, which surfaced as an intermittent undo failure and
 * took a probe run to pin down. The rev on the file is what settles it.
 */

const graphOf = (rev: number, labels: string[]) => ({
  rev,
  nodes: labels.map((label, i) => ({
    id: label.toLowerCase(),
    position: { x: i * 150, y: 0 },
    data: { label },
  })),
  edges: [],
});

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crosspoint-diagram-'));
  const path = join(dir, 'graph.json');
  const diagram = await DiagramFile.open('graph', path);
  diagram.replace(graphOf(5, ['Anchor']));
  await diagram.persistNow();
  return { path, diagram };
};

test('a stale read of our own write is not adopted as an external edit', async () => {
  const { path, diagram } = await fixture();

  // What the watcher sees mid-write: the file as it was an instant ago, at an older rev.
  await writeFile(path, JSON.stringify(graphOf(3, []), null, 2), 'utf8');

  assert.equal(await diagram.reload(), null, 'older than memory, so it is our own echo');
  assert.deepEqual(
    diagram.current().nodes.map((n) => n.data.label),
    ['Anchor'],
    'and the graph is left alone rather than reverted',
  );
});

test('a hand edit at the current rev is still adopted', async () => {
  const { path, diagram } = await fixture();

  // A person editing the file changes labels, not the rev the server last wrote.
  await writeFile(path, JSON.stringify(graphOf(5, ['Edited by hand']), null, 2), 'utf8');

  const incoming = await diagram.reload();
  assert.ok(incoming, 'a real external edit still comes through');
  assert.deepEqual(incoming.nodes.map((n) => n.data.label), ['Edited by hand']);
});

test('an unchanged file is never adopted', async () => {
  const { diagram } = await fixture();
  assert.equal(await diagram.reload(), null, 'byte-identical to what we wrote');
});

test('concurrent saves leave the newest graph on disk', async () => {
  const { path, diagram } = await fixture();

  // Two writes in flight at once used to share one temp path and could land out of order.
  diagram.replace(graphOf(6, ['One']));
  const first = diagram.persistNow();
  diagram.replace(graphOf(7, ['One', 'Two']));
  await Promise.all([first, diagram.persistNow()]);

  const onDisk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(onDisk.rev, 7, 'the later write is the one that survives');
  assert.deepEqual(onDisk.nodes.map((n: { data: { label: string } }) => n.data.label), ['One', 'Two']);
});
