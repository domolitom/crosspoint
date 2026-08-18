import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

/**
 * Named diagrams, against a real server process pointed at a directory.
 *
 * The interesting claim here is that one monotonic rev spans every diagram, because that
 * is what makes a single chronological change feed possible. Most of these tests exist to
 * hold that line.
 */

const PORT = 4299;
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

const op = (body: Record<string, unknown>) => send('/api/op', 'POST', { op: body });

async function until<T>(label: string, fn: () => Promise<T | null> | T | null, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function startServer(target: string, asArgv = false) {
  child = spawn(process.execPath, asArgv ? [entry, target] : [entry], {
    env: {
      ...process.env,
      CROSSPOINT_PORT: String(PORT),
      ...(asArgv ? {} : { CROSSPOINT_DIAGRAMS: target }),
    },
    stdio: 'ignore',
  });
  await until('server to listen', async () => {
    try {
      return (await fetch(`${BASE}/api/graph`)).ok;
    } catch {
      return false;
    }
  });
}

async function stopServer() {
  child?.kill();
  await until('server to stop', async () => {
    try {
      await fetch(`${BASE}/api/graph`);
      return false;
    } catch {
      return true;
    }
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crosspoint-diagrams-'));
  await startServer(dir);
});

after(() => {
  child?.kill();
});

test('an empty directory gets one diagram, and it is active', async () => {
  const { body } = await api('/api/diagrams');
  assert.deepEqual(
    body.diagrams.map((d: any) => d.name),
    ['graph'],
  );
  assert.equal(body.active, 'graph');
});

test('creating a diagram does not change which one is active', async () => {
  const { body } = await send('/api/diagrams', 'POST', { name: 'auth-flow' });
  assert.deepEqual(
    body.diagrams.map((d: any) => d.name),
    ['auth-flow', 'graph'],
  );
  assert.equal(body.active, 'graph', 'the human keeps looking at what they were looking at');
});

test('a created diagram exists on disk and is empty', async () => {
  const file = await until('the new diagram file to appear', async () => {
    try {
      return JSON.parse(await readFile(join(dir, 'auth-flow.json'), 'utf8'));
    } catch {
      return null;
    }
  });
  assert.deepEqual(file.nodes, []);
  assert.deepEqual(file.edges, []);
});

test('creating the same name twice is refused', async () => {
  const { status, body } = await send('/api/diagrams', 'POST', { name: 'auth-flow' });
  assert.equal(status, 400);
  assert.match(body.error, /already exists/);
});

// Names become filenames, so this is the boundary that stops a diagram escaping the
// workspace directory entirely.
test('names that could escape the directory are refused', async () => {
  for (const name of ['../evil', 'a/b', '', '.hidden', 'thing.state']) {
    const { status } = await send('/api/diagrams', 'POST', { name });
    assert.equal(status, 400, `"${name}" should be refused`);
  }
});

test('switching changes what the graph endpoints serve', async () => {
  await op({ op: 'add_node', label: 'In graph' });

  const switched = await send('/api/diagrams/active', 'PUT', { name: 'auth-flow' });
  assert.equal(switched.body.active, 'auth-flow');

  const { body } = await api('/api/graph');
  assert.deepEqual(body.nodes, [], 'the other diagram is empty and untouched');

  await send('/api/diagrams/active', 'PUT', { name: 'graph' });
  const back = await api('/api/graph');
  assert.equal(back.body.nodes.length, 1, 'and switching back finds the node still there');
});

test('switching to a diagram that does not exist is a clean 404', async () => {
  const { status, body } = await send('/api/diagrams/active', 'PUT', { name: 'nope' });
  assert.equal(status, 404);
  assert.match(body.error, /No diagram named "nope"/);

  const { body: still } = await api('/api/diagrams');
  assert.equal(still.active, 'graph', 'and the active diagram is unharmed');
});

// The reason rev is workspace-wide rather than per diagram.
test('ops across two diagrams interleave in one feed, each tagged', async () => {
  await api('/api/changes?actor=all'); // drain

  await op({ op: 'add_node', label: 'First here' });
  await send('/api/diagrams/active', 'PUT', { name: 'auth-flow' });
  await op({ op: 'add_node', label: 'Then there' });
  await send('/api/diagrams/active', 'PUT', { name: 'graph' });
  await op({ op: 'add_node', label: 'Back again' });

  const { body } = await api('/api/changes?actor=all');
  assert.deepEqual(
    body.entries.map((e: any) => [e.diagram, e.op.label]),
    [
      ['graph', 'First here'],
      ['auth-flow', 'Then there'],
      ['graph', 'Back again'],
    ],
    'chronological across diagrams, not grouped by one',
  );

  const revs = body.entries.map((e: any) => e.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b), 'revs ascend across diagrams');
  assert.equal(new Set(revs).size, revs.length, 'and no two ops share a rev');
});

test('a rev is never reused between diagrams', async () => {
  const { body } = await api('/api/changes?since=0&actor=all');
  const revs = body.entries.map((e: any) => e.rev);
  assert.equal(new Set(revs).size, revs.length);
});

test('switching pushes the new diagram to a connected canvas', async () => {
  const socket = new WebSocket(`ws://localhost:${PORT}/ws`);
  const seen: any[] = [];
  socket.on('message', (raw) => seen.push(JSON.parse(String(raw))));
  await until('the canvas to receive its first graph', () =>
    seen.some((m) => m.type === 'graph'),
  );

  const before = seen.length;
  await send('/api/diagrams/active', 'PUT', { name: 'auth-flow' });

  const pushed = await until('a graph for the newly active diagram', () =>
    seen.slice(before).find((m) => m.type === 'graph' && m.diagram === 'auth-flow'),
  );
  assert.ok(pushed, 'the canvas follows the switch without being asked');
  assert.ok(
    seen.slice(before).some((m) => m.type === 'diagrams' && m.active === 'auth-flow'),
    'and is told the list changed',
  );

  socket.close();
  await send('/api/diagrams/active', 'PUT', { name: 'graph' });
});

test('a hand-created file in the directory is adopted as a diagram', async () => {
  await writeFile(
    join(dir, 'by-hand.json'),
    JSON.stringify({ rev: 0, nodes: [{ id: 'a', data: { label: 'A' } }], edges: [] }, null, 2),
    'utf8',
  );

  const body = await until('the new file to be noticed', async () => {
    const res = await api('/api/diagrams');
    return res.body.diagrams.some((d: any) => d.name === 'by-hand') ? res.body : null;
  });
  assert.ok(body.diagrams.find((d: any) => d.name === 'by-hand'));
});

test('the workspace rev survives a restart without going backwards', async () => {
  const before = (await api('/api/changes?since=0&actor=all')).body;
  const highest = Math.max(...before.entries.map((e: any) => e.rev));

  await stopServer();
  await startServer(dir);

  // The workspace counter, not the active diagram's rev — a diagram's stored rev is the
  // workspace rev at which *it* was last written, so it legitimately trails when the most
  // recent ops went somewhere else.
  const { body: after } = await api('/api/changes?since=0&actor=all');
  assert.ok(
    after.rev >= highest,
    `workspace rev went backwards across a restart: ${after.rev} < ${highest}`,
  );

  await op({ op: 'add_node', label: 'After restart' });
  const { body: feed } = await api('/api/changes?since=0&actor=all');
  assert.ok(
    Math.max(...feed.entries.map((e: any) => e.rev)) > highest,
    'and the next op continues above it rather than colliding',
  );
});

test('the active diagram survives a restart', async () => {
  await send('/api/diagrams/active', 'PUT', { name: 'auth-flow' });
  await stopServer();
  await startServer(dir);

  const { body } = await api('/api/diagrams');
  assert.equal(body.active, 'auth-flow');
  await send('/api/diagrams/active', 'PUT', { name: 'graph' });
});

// The compatibility path: the old single-file form must keep working, and must not treat
// its containing directory as a pile of diagrams.
test('a .json path still works and yields exactly one diagram', async () => {
  await stopServer();
  const fileDir = await mkdtemp(join(tmpdir(), 'crosspoint-file-mode-'));
  // Junk that a directory scan would wrongly adopt.
  await writeFile(join(fileDir, 'package.json'), '{"name":"not-a-diagram"}', 'utf8');
  await writeFile(join(fileDir, 'tsconfig.json'), '{}', 'utf8');

  await startServer(join(fileDir, 'graph.json'), true);

  const { body } = await api('/api/diagrams');
  assert.deepEqual(
    body.diagrams.map((d: any) => d.name),
    ['graph'],
    'the directory is not scanned in file mode',
  );
  assert.equal(body.active, 'graph');

  await op({ op: 'add_node', label: 'Works' });
  const { body: graph } = await api('/api/graph');
  assert.equal(graph.nodes.length, 1);
});
