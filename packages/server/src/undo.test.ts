import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

/**
 * Undo and redo, against a real server process.
 *
 * Snapshot-based, so the interesting assertions are about *exactness* — a restored graph has
 * to match what was there including positions — and about scope: history is per diagram, and
 * one Cmd+Z must not reach into a diagram nobody is looking at.
 */

const PORT = 4319;
const BASE = `http://localhost:${PORT}`;
const entry = fileURLToPath(new URL('./index.js', import.meta.url));

let child: ChildProcess;
let dir: string;

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: (await res.json()) as any };
};

const post = (path: string, body?: Record<string, unknown>) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const op = (body: Record<string, unknown>, diagram?: string) =>
  post('/api/op', diagram ? { op: body, diagram } : { op: body });

const graph = async (diagram?: string) =>
  (await api(`/api/graph${diagram ? `?diagram=${diagram}` : ''}`)).body;

async function until<T>(label: string, fn: () => Promise<T | null> | T | null, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crosspoint-undo-'));
  child = spawn(process.execPath, [entry, dir], {
    env: { ...process.env, CROSSPOINT_PORT: String(PORT) },
    stdio: 'ignore',
  });
  await until('server to listen', async () => {
    try {
      return (await fetch(`${BASE}/api/graph`)).ok;
    } catch {
      return false;
    }
  });
});

after(() => {
  child?.kill();
});

test('undo on a diagram with no history is a quiet no-op', async () => {
  const before = (await api('/api/graph')).body.rev;
  const { status, body } = await post('/api/undo');
  assert.equal(status, 200, 'not an error — pressing undo on a fresh diagram is ordinary');
  assert.equal(body.changed, false);
  assert.equal((await api('/api/graph')).body.rev, before, 'nothing happened, so no new rev');
});

test('undo removes the node that was just added', async () => {
  await op({ op: 'add_node', label: 'First' });
  await op({ op: 'add_node', label: 'Second' });
  assert.equal((await graph()).nodes.length, 2);

  const { body } = await post('/api/undo');
  assert.equal(body.changed, true);
  const after = await graph();
  assert.deepEqual(after.nodes.map((n: any) => n.id), ['first']);
});

test('undo twice steps back twice', async () => {
  await post('/api/undo');
  assert.equal((await graph()).nodes.length, 0);
});

test('redo replays what was undone, in order', async () => {
  await post('/api/redo');
  assert.deepEqual((await graph()).nodes.map((n: any) => n.id), ['first']);
  await post('/api/redo');
  assert.deepEqual((await graph()).nodes.map((n: any) => n.id), ['first', 'second']);
});

test('redo past the end is a quiet no-op', async () => {
  const { body } = await post('/api/redo');
  assert.equal(body.changed, false);
});

// The exactness that matters: a restored graph is the old graph, not an approximation.
test('undo restores a position precisely', async () => {
  await op({ op: 'move_node', id: 'first', position: { x: 615, y: 450 } });
  const moved = (await graph()).nodes.find((n: any) => n.id === 'first');
  assert.deepEqual(moved.position, { x: 615, y: 450 });

  await op({ op: 'move_node', id: 'first', position: { x: 15, y: 30 } });
  await post('/api/undo');

  const restored = (await graph()).nodes.find((n: any) => n.id === 'first');
  assert.deepEqual(restored.position, { x: 615, y: 450 }, 'the exact previous position');
});

test('a new change clears the redo stack', async () => {
  await post('/api/undo');
  assert.ok((await api('/api/history')).body.redo > 0, 'something to redo after an undo');

  await op({ op: 'add_node', label: 'Diverged' });
  assert.equal((await api('/api/history')).body.redo, 0, 'the old future is unreachable');

  const { body } = await post('/api/redo');
  assert.equal(body.changed, false);
});

test('history is scoped to its diagram', async () => {
  await post('/api/diagrams', { name: 'other' });
  await op({ op: 'add_node', label: 'Only here' }, 'other');
  const mainBefore = await graph();

  await post('/api/undo', { diagram: 'other' });
  assert.equal((await graph('other')).nodes.length, 0, 'the targeted diagram stepped back');
  assert.deepEqual(
    (await graph()).nodes.map((n: any) => n.id),
    mainBefore.nodes.map((n: any) => n.id),
    'the diagram nobody was looking at is untouched',
  );
});

test('the feed records what was undone, not a bare "undo"', async () => {
  const since = (await api('/api/graph')).body.rev;
  await op({ op: 'add_node', label: 'Retract me' }, 'other');
  await post('/api/undo', { diagram: 'other' });

  const { body } = await api(`/api/changes?since=${since}&actor=all`);
  assert.match(body.summary, /\+ node "Retract me"/, 'the original is still on record');
  assert.match(body.summary, /undid: \+ node "Retract me"/, 'and so is the retraction');
});

test('an external hand edit is undoable', async () => {
  const path = join(dir, 'other.json');
  await op({ op: 'add_node', label: 'Anchor' }, 'other');
  await until('the node to reach disk', async () => {
    const text = await readFile(path, 'utf8').catch(() => '');
    return text.includes('Anchor') ? text : null;
  });

  const onDisk = JSON.parse(await readFile(path, 'utf8'));
  onDisk.nodes.find((n: any) => n.id === 'anchor').data.label = 'Edited by hand';
  await writeFile(path, JSON.stringify(onDisk, null, 2), 'utf8');

  await until('the edit to be picked up', async () => {
    const g = await graph('other');
    return g.nodes.some((n: any) => n.data.label === 'Edited by hand');
  });

  await post('/api/undo', { diagram: 'other' });
  const restored = await graph('other');
  assert.ok(
    restored.nodes.some((n: any) => n.data.label === 'Anchor'),
    'undo reaches a change made outside the app',
  );
});

// A stack that grows without bound is a leak; one that drops the newest is a bug.
test('history is bounded, and it is the oldest step that is dropped', async () => {
  await post('/api/diagrams', { name: 'deep' });
  for (let i = 0; i < 60; i++) {
    await op({ op: 'add_node', label: `n${i}` }, 'deep');
  }
  const depth = (await api('/api/history?diagram=deep')).body;
  assert.equal(depth.undo, 50, `capped at 50, got ${depth.undo}`);

  // Walk all the way back. The oldest steps are gone, so the earliest nodes survive.
  for (let i = 0; i < 50; i++) await post('/api/undo', { diagram: 'deep' });
  const left = (await graph('deep')).nodes.length;
  assert.equal(left, 10, `the 10 oldest additions are beyond reach, got ${left} nodes`);
  assert.equal((await api('/api/history?diagram=deep')).body.undo, 0);
});
