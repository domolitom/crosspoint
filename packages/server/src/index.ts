import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { structuralView, type GraphOp } from '@crosspoint/core';
import { WebSocketServer, type WebSocket } from 'ws';

import { GraphStore, StaleRevError } from './store.js';

const PORT = Number(process.env.CROSSPOINT_PORT ?? 4000);
const GRAPH_PATH = process.env.CROSSPOINT_GRAPH ?? process.argv[2] ?? 'graph.json';

const store = await GraphStore.open(GRAPH_PATH);

const KNOWN_OPS = new Set([
  'add_node',
  'add_edge',
  'update_node',
  'update_edge',
  'delete_node',
  'delete_edge',
  'move_node',
]);

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/graph') {
      // Full view, geometry included — this is what the canvas renders.
      return json(res, 200, store.current());
    }

    if (req.method === 'GET' && url.pathname === '/api/graph/structural') {
      // Agent view: structure and labels only. Coordinates are data an agent must
      // preserve, not data it consumes, so they are omitted unless asked for.
      return json(res, 200, structuralView(store.current()));
    }

    if (req.method === 'POST' && url.pathname === '/api/op') {
      const body = await readJson(req);
      const op = body.op as GraphOp | undefined;
      if (!op || typeof op.op !== 'string' || !KNOWN_OPS.has(op.op)) {
        return json(res, 400, { error: `Unknown op: ${JSON.stringify(body.op)}` });
      }
      const graph = store.apply(op, { baseRev: body.baseRev, origin: body.clientId });
      return json(res, 200, { rev: graph.rev, graph: structuralView(graph) });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err instanceof StaleRevError ? 409 : 400;
    return json(res, status, { error: (err as Error).message });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
let clientSeq = 0;

wss.on('connection', (socket: WebSocket) => {
  const clientId = `c${++clientSeq}`;
  socket.send(JSON.stringify({ type: 'hello', clientId }));
  socket.send(JSON.stringify({ type: 'graph', graph: store.current() }));

  const unsubscribe = store.subscribe(({ graph, origin }) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ type: 'graph', graph, origin }));
  });

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'op') return;
      store.apply(msg.op as GraphOp, { origin: clientId });
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
    }
  });

  socket.on('close', unsubscribe);
});

function send(res: ServerResponse, status: number, body: string, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown) {
  send(res, status, JSON.stringify(body), 'application/json');
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

server.listen(PORT, () => {
  console.log(`crosspoint server  http://localhost:${PORT}`);
  console.log(`graph              ${store.path}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void store.close().then(() => process.exit(0));
  });
}
