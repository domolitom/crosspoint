import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

/**
 * Writing to a diagram the human is not looking at.
 *
 * This is what a lens panel needs: it renders a subcanvas floating over the main canvas,
 * so its edits must land in that diagram while the active one stays put. An agent
 * detailing a step needs exactly the same thing.
 */

const PORT = 4311;
const BASE = `http://localhost:${PORT}`;
const entry = fileURLToPath(new URL('./index.js', import.meta.url));

let child: ChildProcess;
let dir: string;

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: (await res.json()) as any };
};

const send = (path: string, method: string, body: unknown) =>
  api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const op = (body: Record<string, unknown>, diagram?: string) =>
  send('/api/op', 'POST', diagram ? { op: body, diagram } : { op: body });

async function until<T>(label: string, fn: () => Promise<T | null> | T | null, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crosspoint-sub-'));
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, CROSSPOINT_PORT: String(PORT), CROSSPOINT_DIAGRAMS: dir },
    stdio: 'ignore',
  });
  await until('server to listen', async () => {
    try {
      return (await fetch(`${BASE}/api/graph`)).ok;
    } catch {
      return false;
    }
  });

  await op({ op: 'add_node', label: 'Step 2' });
  await send('/api/diagrams', 'POST', { name: 'step-2-impl' });
});

after(() => {
  child?.kill();
});

test('an op with an explicit diagram writes there and leaves the active one alone', async () => {
  const { status } = await op({ op: 'add_node', label: 'Tokenize' }, 'step-2-impl');
  assert.equal(status, 200);

  const { body: sub } = await api('/api/graph?diagram=step-2-impl');
  assert.deepEqual(
    sub.nodes.map((n: any) => n.data.label),
    ['Tokenize'],
  );

  const { body: diagrams } = await api('/api/diagrams');
  assert.equal(diagrams.active, 'graph', 'the human was not moved');

  const { body: main } = await api('/api/graph');
  assert.deepEqual(
    main.nodes.map((n: any) => n.data.label),
    ['Step 2'],
    'and the active diagram is untouched',
  );
});

test('reading a diagram by name does not switch to it', async () => {
  await api('/api/graph?diagram=step-2-impl');
  const { body } = await api('/api/diagrams');
  assert.equal(body.active, 'graph');
});

test('the feed tags each entry with the diagram it happened in', async () => {
  const { body } = await api('/api/changes?since=0');
  const byDiagram = body.entries.reduce((acc: Record<string, string[]>, e: any) => {
    (acc[e.diagram] ??= []).push(e.op.label ?? e.op.op);
    return acc;
  }, {});
  assert.deepEqual(byDiagram.graph, ['Step 2']);
  assert.deepEqual(byDiagram['step-2-impl'], ['Tokenize']);
});

// Without this an open panel goes silently stale: it is live on a diagram that is not the
// active one, so a push filtered to the active diagram would never reach it.
test('a change to a non-active diagram still reaches a connected client', async () => {
  const socket = new WebSocket(`ws://localhost:${PORT}/ws`);
  const seen: Array<{ diagram: string; labels: string[] }> = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'graph') {
      seen.push({ diagram: msg.diagram, labels: msg.graph.nodes.map((n: any) => n.data.label) });
    }
  });
  await until('the socket to receive its initial graph', () => seen.length > 0);

  await op({ op: 'add_node', label: 'Validate' }, 'step-2-impl');

  const pushed = await until('the panel diagram to be pushed', () =>
    seen.find((s) => s.diagram === 'step-2-impl' && s.labels.includes('Validate')),
  );
  assert.ok(pushed, 'the client watching `graph` was told about `step-2-impl`');
  socket.close();
});

test('an op naming an unknown diagram is refused cleanly', async () => {
  const { status, body } = await op({ op: 'add_node', label: 'Nowhere' }, 'ghost');
  assert.equal(status, 404);
  assert.match(body.error, /No diagram named "ghost"/);
});

// The user's decision: deleting a box must not destroy an hour of sub-planning.
test('deleting the linked node orphans the subcanvas rather than deleting it', async () => {
  await op({ op: 'update_node', id: 'step-2', subcanvas: 'step-2-impl' });

  const { body: before } = await api('/api/graph');
  assert.equal(
    before.nodes.find((n: any) => n.id === 'step-2').data.subcanvas,
    'step-2-impl',
    'the link is stored on the node',
  );

  await op({ op: 'delete_node', id: 'step-2' });

  const { body: diagrams } = await api('/api/diagrams');
  assert.ok(
    diagrams.diagrams.some((d: any) => d.name === 'step-2-impl'),
    'the subcanvas is still listed after its parent node is gone',
  );

  const { body: sub } = await api('/api/graph?diagram=step-2-impl');
  assert.ok(sub.nodes.length >= 2, 'and its contents survive');
});
