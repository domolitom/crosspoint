import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

/**
 * The change feed, end to end against a real server process.
 *
 * This is the step that makes the project's central bet testable — that a graph diff
 * reads as an instruction — so the semantics here matter more than most.
 */

const PORT = 4231;
const BASE = `http://localhost:${PORT}`;
const entry = fileURLToPath(new URL('./index.js', import.meta.url));

let child: ChildProcess;
let dir: string;
let graphPath: string;

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: (await res.json()) as any };
};

const op = (body: Record<string, unknown>) =>
  api('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: body }),
  });

async function until<T>(label: string, fn: () => Promise<T | null> | T | null, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function startServer() {
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, CROSSPOINT_PORT: String(PORT), CROSSPOINT_GRAPH: graphPath },
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

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crosspoint-log-'));
  graphPath = join(dir, 'graph.json');
  await startServer();
});

after(() => {
  child?.kill();
});

test('applied ops are logged in order with their revs', async () => {
  await op({ op: 'add_node', label: 'Fetch' });
  await op({ op: 'add_node', label: 'Cache' });
  await op({ op: 'add_edge', source: 'fetch', target: 'cache' });

  const { body } = await api('/api/changes?since=0');
  assert.deepEqual(
    body.entries.map((e: any) => [e.rev, e.op.op]),
    [
      [1, 'add_node'],
      [2, 'add_node'],
      [3, 'add_edge'],
    ],
  );
  assert.equal(body.entries[0].diagram, 'graph', 'entries carry their diagram');
  assert.ok(body.entries[0].ts, 'entries are timestamped');
});

test('a rejected op leaves no trace in the log', async () => {
  const before = (await api('/api/changes?since=0')).body.entries.length;
  const { status } = await op({ op: 'add_edge', source: 'fetch', target: 'ghost' });
  assert.equal(status, 400);

  const { body } = await api('/api/changes?since=0');
  assert.equal(body.entries.length, before, 'the log records what happened, not what was tried');
});

test('ops are tagged, and the tag is what the default filter acts on', async () => {
  await op({ op: 'move_node', id: 'fetch', position: { x: 300, y: 150 } });

  const { body } = await api('/api/changes?since=0&include_layout=true');
  const move = body.entries.find((e: any) => e.op.op === 'move_node');
  const add = body.entries.find((e: any) => e.op.op === 'add_node');
  assert.equal(move.kind, 'layout');
  assert.equal(add.kind, 'structural');

  const { body: plain } = await api('/api/changes?since=0');
  assert.ok(
    !plain.entries.some((e: any) => e.op.op === 'move_node'),
    'and without the flag that same move is gone',
  );
});

test('the summary reads as prose, not as raw ops', async () => {
  const { body } = await api('/api/changes?since=0');
  assert.match(body.summary, /\+ node "Fetch"/);
  assert.match(body.summary, /\+ edge fetch → cache/);
});

// The watermark is what survives my context being wiped; these semantics are the
// difference between "what changed since we last spoke" working and silently lying.
test('a no-argument call consumes, and a second returns nothing', async () => {
  const first = await api('/api/changes');
  assert.ok(first.body.entries.length > 0, 'first call returns the backlog');

  const second = await api('/api/changes');
  assert.deepEqual(second.body.entries, [], 'nothing is new the second time');
  assert.equal(second.body.summary, 'No changes.');
});

test('an explicit since is repeatable and does not disturb the watermark', async () => {
  const before = (await api('/api/changes?since=0')).body.watermark;

  const a = await api('/api/changes?since=1');
  const b = await api('/api/changes?since=1');
  assert.deepEqual(a.body.entries, b.body.entries, 'explicit queries repeat identically');

  const after = (await api('/api/changes?since=0')).body.watermark;
  assert.equal(after, before, 'the watermark is untouched by explicit queries');
});

test('only new ops appear after the watermark has advanced', async () => {
  await api('/api/changes'); // drain
  await op({ op: 'add_node', label: 'Retry' });

  const { body } = await api('/api/changes');
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].op.label, 'Retry');
});

test('a hand edit of the file is reported as an external change', async () => {
  await api('/api/changes'); // drain

  // Persistence is debounced, so wait for the node to actually be on disk before
  // editing it — otherwise we race the server's own write.
  const graph = await until('cache node to reach disk', async () => {
    const g = JSON.parse(await readFile(graphPath, 'utf8'));
    return g.nodes.some((n: any) => n.id === 'cache') ? g : null;
  });
  graph.nodes.find((n: any) => n.id === 'cache').data.label = 'Redis';
  await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');

  const body = await until('external edit to be recorded', async () => {
    const res = await api('/api/changes?since=0');
    return res.body.entries.some((e: any) => e.kind === 'external') ? res.body : null;
  });

  const external = body.entries.filter((e: any) => e.kind === 'external');
  assert.equal(external.length, 1, 'one entry per external edit');
  assert.equal(external[0].op.op, 'external_edit');
  assert.match(body.summary, /edited outside the server/);
});

test('history survives a restart', async () => {
  const before = (await api('/api/changes?since=0')).body.entries;
  assert.ok(before.length > 3);

  child.kill();
  await until('server to stop', async () => {
    try {
      await fetch(`${BASE}/api/graph`);
      return false;
    } catch {
      return true;
    }
  });
  await startServer();

  const { body } = await api('/api/changes?since=0');
  assert.deepEqual(
    body.entries.map((e: any) => [e.rev, e.op.op]),
    before.map((e: any) => [e.rev, e.op.op]),
    'the log is reread from disk, not lost',
  );
});

test('the watermark also survives a restart', async () => {
  // Drained before the restart above, so a no-arg call must not re-serve old entries.
  const { body } = await api('/api/changes');
  assert.ok(
    body.entries.every((e: any) => e.kind === 'external' || e.rev > 5),
    'a restart does not resurrect already-consumed history',
  );
});

test('repositioning is left out of the feed unless asked for', async () => {
  await op({ op: 'add_node', label: 'Fetch' });
  await op({ op: 'add_node', label: 'Cache' });
  const base = (await api('/api/graph')).body.rev;

  // What a human tidying up produces: one real change buried in moves.
  await op({ op: 'move_node', id: 'fetch', position: { x: 300, y: 150 } });
  await op({ op: 'add_edge', source: 'fetch', target: 'cache' });
  await op({ op: 'move_node', id: 'cache', position: { x: 300, y: 300 } });
  await op({ op: 'move_node', id: 'fetch', position: { x: 315, y: 150 } });

  const { body: filtered } = await api(`/api/changes?since=${base}`);
  assert.deepEqual(
    filtered.entries.map((e: any) => e.op.op),
    ['add_edge'],
    'only the change that carried the message survives',
  );

  const { body: full } = await api(`/api/changes?since=${base}&include_layout=true`);
  assert.equal(full.entries.length, 4, 'the moves are still on record when asked for');
});

// If the watermark stopped at filtered entries they would stay unseen forever, and
// every later call would re-scan the same pile of moves.
test('consuming advances past repositioning even though it is not returned', async () => {
  await op({ op: 'move_node', id: 'fetch', position: { x: 0, y: 0 } });
  await op({ op: 'move_node', id: 'cache', position: { x: 0, y: 150 } });

  const drained = await api('/api/changes');
  assert.ok(
    !drained.body.entries.some((e: any) => e.kind === 'layout'),
    'no layout entries in the response',
  );

  const { body: after } = await api('/api/changes');
  assert.deepEqual(after.entries, [], 'the moves were consumed, not left pending');
  assert.equal(after.watermark, after.rev, 'watermark caught up to the latest rev');
});
