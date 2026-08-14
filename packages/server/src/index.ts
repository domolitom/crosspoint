import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { structuralView, summarise, withoutLayout, type GraphOp } from '@crosspoint/core';
import { WebSocketServer, type WebSocket } from 'ws';

import { StaleRevError, UnknownDiagramError, Workspace } from './workspace.js';

const PORT = Number(process.env.CROSSPOINT_PORT ?? 4000);
// A directory holds many diagrams; a `.json` path is the older single-file form, kept
// working so an existing graph stays live rather than needing to be moved.
const TARGET =
  process.env.CROSSPOINT_DIAGRAMS ?? process.env.CROSSPOINT_GRAPH ?? process.argv[2] ?? 'diagrams';

const store = await Workspace.open(TARGET);

const KNOWN_OPS = new Set([
  'add_node',
  'add_node_at',
  'add_edge',
  'reconnect_edge',
  'update_node',
  'update_edge',
  'delete_node',
  'delete_edge',
  'generate_graph',
  // Layout intent, resolved server-side. On the agent surface because they carry no
  // coordinate; tagged `layout` in the feed because they only move boxes.
  'align',
  'distribute',
  'move_node',
]);

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  try {
    // `?diagram=` reads one the human is not looking at — a lens panel renders a
    // subcanvas without switching, and an agent can inspect one the same way.
    const named = url.searchParams.get('diagram') ?? undefined;

    if (req.method === 'GET' && url.pathname === '/api/graph') {
      // Full view, geometry included — this is what the canvas renders.
      return json(res, 200, store.graphOf(named));
    }

    if (req.method === 'GET' && url.pathname === '/api/graph/structural') {
      // Agent view: structure and labels only. Coordinates are data an agent must
      // preserve, not data it consumes, so they are omitted unless asked for.
      return json(res, 200, structuralView(store.graphOf(named)));
    }

    if (req.method === 'GET' && url.pathname === '/api/changes') {
      // No `since` means "everything I have not seen", which consumes. An explicit
      // `since` is a repeatable query and deliberately leaves the watermark alone.
      const raw = url.searchParams.get('since');
      const all = raw === null ? store.consumeChanges() : store.changesSince(Number(raw));
      // Repositioning is dropped unless asked for. Note the watermark has already moved
      // past those entries: they are filtered out of the *response*, not left unseen, or
      // every subsequent call would re-scan the same pile of moves forever.
      const entries =
        url.searchParams.get('include_layout') === 'true' ? all : withoutLayout(all);
      return json(res, 200, {
        // The workspace rev, not the active diagram's. The feed spans every diagram and
        // `since` is measured against the same counter, so reporting one diagram's
        // last-write rev here would be answering a different question.
        rev: store.rev,
        watermark: store.log.watermark,
        summary: summarise(entries),
        entries,
      });
    }

    // Diagram management is workspace-level, deliberately not a GraphOp: creating or
    // switching changes nothing *inside* a diagram, so it has no place in the op log or
    // in a graph's rev.
    if (req.method === 'GET' && url.pathname === '/api/diagrams') {
      return json(res, 200, { active: store.active, diagrams: store.list() });
    }

    if (req.method === 'POST' && url.pathname === '/api/diagrams') {
      const body = await readJson(req);
      await store.create(String(body.name ?? ''));
      return json(res, 200, { active: store.active, diagrams: store.list() });
    }

    if (req.method === 'PUT' && url.pathname === '/api/diagrams/active') {
      const body = await readJson(req);
      store.switchTo(String(body.name ?? ''));
      return json(res, 200, { active: store.active, diagrams: store.list() });
    }

    if (req.method === 'POST' && url.pathname === '/api/op') {
      const body = await readJson(req);
      const op = body.op as GraphOp | undefined;
      if (!op || typeof op.op !== 'string' || !KNOWN_OPS.has(op.op)) {
        return json(res, 400, { error: `Unknown op: ${JSON.stringify(body.op)}` });
      }
      // An explicit diagram writes there without switching the human's view. That is what
      // lets a lens panel edit a subcanvas, and an agent detail a step, while the main
      // canvas stays where it is.
      const graph = store.apply(op, {
        baseRev: body.baseRev,
        origin: body.clientId,
        diagram: body.diagram ? String(body.diagram) : undefined,
      });
      return json(res, 200, { rev: graph.rev, graph: structuralView(graph) });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    const status =
      err instanceof StaleRevError ? 409 : err instanceof UnknownDiagramError ? 404 : 400;
    return json(res, status, { error: (err as Error).message });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
let clientSeq = 0;

wss.on('connection', (socket: WebSocket) => {
  const clientId = `c${++clientSeq}`;
  const send = (message: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  send({ type: 'hello', clientId });
  send({ type: 'diagrams', active: store.active, diagrams: store.list() });
  send({ type: 'graph', diagram: store.active, graph: store.current() });

  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'diagrams') {
      return send({ type: 'diagrams', active: store.active, diagrams: store.list() });
    }
    // Every diagram is pushed, tagged with its name, and the client renders what it needs.
    // A lens panel is live on a diagram that is not the active one, so filtering to the
    // active diagram here would leave an open panel silently stale. Simpler than per-client
    // subscriptions, and the payload is irrelevant for a local single-user tool.
    send({ type: 'graph', diagram: event.diagram, graph: event.graph, origin: event.origin });
  });

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'op') return;
      store.apply(msg.op as GraphOp, {
        origin: clientId,
        diagram: msg.diagram ? String(msg.diagram) : undefined,
      });
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
  console.log(`diagrams           ${store.dir}  (active: ${store.active})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void store.close().then(() => process.exit(0));
  });
}
