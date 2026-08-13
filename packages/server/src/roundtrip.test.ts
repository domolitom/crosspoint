import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

/**
 * End-to-end: a real server process, a websocket client standing in for the canvas,
 * and HTTP calls standing in for the MCP server. Verifies the two claims the whole
 * design rests on — agent edits reach the canvas live, and human layout survives them.
 */

const PORT = 4187;
const BASE = `http://localhost:${PORT}`;
const entry = fileURLToPath(new URL('./index.js', import.meta.url));

let child: ChildProcess;
let graphPath: string;
/** Every graph message the "canvas" has received, in order. */
let received: any[] = [];
let socket: WebSocket;

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: (await res.json()) as any };
};

const agentOp = (op: Record<string, unknown>) =>
  api('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op }),
  });

const readGraphFile = async () => JSON.parse(await readFile(graphPath, 'utf8'));

async function until<T>(label: string, fn: () => Promise<T | null> | T | null, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crosspoint-'));
  graphPath = join(dir, 'graph.json');

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

  socket = new WebSocket(`ws://localhost:${PORT}/ws`);
  socket.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'graph') received.push(msg.graph);
  });
  await until('canvas to receive initial graph', () => received.length > 0);
});

after(async () => {
  socket?.close();
  child?.kill();
});

test('an agent edit reaches the canvas live, without a reload', async () => {
  const before = received.length;
  const { status } = await agentOp({ op: 'add_node', label: 'Auth service' });
  assert.equal(status, 200);

  const pushed = await until('canvas to see the new node', () =>
    received.slice(before).find((g) => g.nodes.some((n: any) => n.id === 'auth-service')),
  );
  assert.ok(pushed, 'the canvas was pushed a graph containing the agent-added node');
});

test('the server places agent-added nodes, so the agent never invents coordinates', async () => {
  // Persistence is debounced, so poll rather than assuming the write already landed.
  const node = await until('node to appear on disk', async () => {
    const graph = await readGraphFile();
    return graph.nodes.find((n: any) => n.id === 'auth-service') ?? null;
  });
  assert.ok(node.position, 'node was seeded with a position');
  assert.equal(typeof node.position.x, 'number');
});

test('a canvas drag persists to disk', async () => {
  socket.send(
    JSON.stringify({
      type: 'op',
      op: { op: 'move_node', id: 'auth-service', position: { x: 615, y: 450 } },
    }),
  );

  const graph = await until('drag to reach disk', async () => {
    const g = await readGraphFile();
    const node = g.nodes.find((n: any) => n.id === 'auth-service');
    return node?.position?.x === 615 ? g : null;
  });
  assert.deepEqual(
    graph.nodes.find((n: any) => n.id === 'auth-service').position,
    { x: 615, y: 450 },
  );
});

// The claim that motivates the MCP-over-file-editing choice.
test('agent structural edits do not disturb a human-placed node', async () => {
  await agentOp({ op: 'add_node', label: 'Database' });
  await agentOp({ op: 'add_edge', source: 'auth-service', target: 'database' });
  await agentOp({ op: 'update_node', id: 'auth-service', label: 'Auth API' });

  const graph = await until('edits to settle on disk', async () => {
    const g = await readGraphFile();
    return g.nodes.length === 2 && g.edges.length === 1 ? g : null;
  });

  const auth = graph.nodes.find((n: any) => n.id === 'auth-service');
  assert.deepEqual(auth.position, { x: 615, y: 450 }, 'pinned position survived');
  assert.equal(auth.data.label, 'Auth API', 'relabel still applied');
});

test('the agent view omits coordinates entirely', async () => {
  const { body } = await api('/api/graph/structural');
  assert.ok(!JSON.stringify(body).includes('position'));
  assert.deepEqual(body.nodes[0], { id: 'auth-service', label: 'Auth API' });
  assert.equal(body.edges[0].source, 'auth-service');
});

test('the canvas view includes coordinates', async () => {
  const { body } = await api('/api/graph');
  assert.ok(body.nodes[0].position, 'canvas needs geometry to render');
});

test('a hand edit of the file on disk reaches the canvas', async () => {
  const graph = await readGraphFile();
  graph.nodes.find((n: any) => n.id === 'database').data.label = 'Postgres';
  const before = received.length;
  await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');

  const pushed = await until('canvas to see the external edit', () =>
    received
      .slice(before)
      .find((g) => g.nodes.some((n: any) => n.data.label === 'Postgres')),
  );
  assert.ok(pushed);
});

test('stale writes are rejected rather than silently applied', async () => {
  const { body: current } = await api('/api/graph');
  const { status } = await api('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: { op: 'add_node', label: 'Late' }, baseRev: current.rev - 1 }),
  });
  assert.equal(status, 409);
});

test('edges to unknown nodes are refused at the API boundary', async () => {
  const { status, body } = await agentOp({
    op: 'add_edge',
    source: 'auth-service',
    target: 'nope',
  });
  assert.equal(status, 400);
  assert.match(body.error, /No node with id "nope"/);
});
