import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

/**
 * The change feed, end to end against a real server process.
 *
 * This is the step that makes the project's central bet testable — that a graph diff
 * reads as an instruction — so the semantics here matter more than most.
 *
 * Every feed read below passes `actor=all` on purpose. These ops go over HTTP, which the
 * server attributes to the agent, and the production default is human-authored only — so a
 * bare read would correctly return nothing and these tests would be asserting against an
 * empty list. They are about ordering, kinds, the watermark and restart behaviour, not
 * attribution; attribution has its own tests at the bottom of the file.
 */

const PORT = 4231;
const BASE = `http://localhost:${PORT}`;
const entry = fileURLToPath(new URL('./index.js', import.meta.url));

let child: ChildProcess;
let dir: string;
let graphPath: string;

const readGraphFile = async () => JSON.parse(await readFile(graphPath, 'utf8'));

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

  const { body } = await api('/api/changes?since=0&actor=all');
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
  const before = (await api('/api/changes?since=0&actor=all')).body.entries.length;
  const { status } = await op({ op: 'add_edge', source: 'fetch', target: 'ghost' });
  assert.equal(status, 400);

  const { body } = await api('/api/changes?since=0&actor=all');
  assert.equal(body.entries.length, before, 'the log records what happened, not what was tried');
});

test('ops are tagged, and the tag is what the default filter acts on', async () => {
  await op({ op: 'move_node', id: 'fetch', position: { x: 300, y: 150 } });

  const { body } = await api('/api/changes?since=0&include_layout=true&actor=all');
  const move = body.entries.find((e: any) => e.op.op === 'move_node');
  const add = body.entries.find((e: any) => e.op.op === 'add_node');
  assert.equal(move.kind, 'layout');
  assert.equal(add.kind, 'structural');

  const { body: plain } = await api('/api/changes?since=0&actor=all');
  assert.ok(
    !plain.entries.some((e: any) => e.op.op === 'move_node'),
    'and without the flag that same move is gone',
  );
});

test('the summary reads as prose, not as raw ops', async () => {
  const { body } = await api('/api/changes?since=0&actor=all');
  assert.match(body.summary, /\+ node "Fetch"/);
  assert.match(body.summary, /\+ edge fetch → cache/);
});

// The watermark is what survives my context being wiped; these semantics are the
// difference between "what changed since we last spoke" working and silently lying.
test('a no-argument call consumes, and a second returns nothing', async () => {
  const first = await api('/api/changes?actor=all');
  assert.ok(first.body.entries.length > 0, 'first call returns the backlog');

  const second = await api('/api/changes?actor=all');
  assert.deepEqual(second.body.entries, [], 'nothing is new the second time');
  assert.equal(second.body.summary, 'No changes.');
});

test('an explicit since is repeatable and does not disturb the watermark', async () => {
  const before = (await api('/api/changes?since=0&actor=all')).body.watermark;

  const a = await api('/api/changes?since=1&actor=all');
  const b = await api('/api/changes?since=1&actor=all');
  assert.deepEqual(a.body.entries, b.body.entries, 'explicit queries repeat identically');

  const after = (await api('/api/changes?since=0&actor=all')).body.watermark;
  assert.equal(after, before, 'the watermark is untouched by explicit queries');
});

test('only new ops appear after the watermark has advanced', async () => {
  await api('/api/changes?actor=all'); // drain
  await op({ op: 'add_node', label: 'Retry' });

  const { body } = await api('/api/changes?actor=all');
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].op.label, 'Retry');
});

test('a hand edit of the file is reported as an external change', async () => {
  await api('/api/changes?actor=all'); // drain

  // Persistence is debounced, so wait for the node to actually be on disk before
  // editing it — otherwise we race the server's own write.
  const graph = await until('cache node to reach disk', async () => {
    const g = JSON.parse(await readFile(graphPath, 'utf8'));
    return g.nodes.some((n: any) => n.id === 'cache') ? g : null;
  });
  graph.nodes.find((n: any) => n.id === 'cache').data.label = 'Redis';
  await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');

  const body = await until('external edit to be recorded', async () => {
    const res = await api('/api/changes?since=0&actor=all');
    return res.body.entries.some((e: any) => e.kind === 'external') ? res.body : null;
  });

  const external = body.entries.filter((e: any) => e.kind === 'external');
  assert.equal(external.length, 1, 'one entry per external edit');
  assert.equal(external[0].op.op, 'external_edit');
  assert.match(body.summary, /edited outside the server/);
});

test('history survives a restart', async () => {
  const before = (await api('/api/changes?since=0&actor=all')).body.entries;
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

  const { body } = await api('/api/changes?since=0&actor=all');
  assert.deepEqual(
    body.entries.map((e: any) => [e.rev, e.op.op]),
    before.map((e: any) => [e.rev, e.op.op]),
    'the log is reread from disk, not lost',
  );
});

test('the watermark also survives a restart', async () => {
  // Drained before the restart above, so a no-arg call must not re-serve old entries.
  const { body } = await api('/api/changes?actor=all');
  assert.ok(
    body.entries.every((e: any) => e.kind === 'external' || e.rev > 5),
    'a restart does not resurrect already-consumed history',
  );
});

// Colour is structural, so unlike a move it must survive the default filter — a red node
// is a message, and dropping it as noise would lose the message.
test('a colour change reaches the feed even with the layout filter on', async () => {
  await op({ op: 'add_node', label: 'Broken' });
  const base = (await api('/api/graph')).body.rev;

  await op({ op: 'move_node', id: 'broken', position: { x: 300, y: 300 } });
  await op({ op: 'update_node', id: 'broken', color: 'red' });

  const { body } = await api(`/api/changes?since=${base}&actor=all`);
  assert.deepEqual(
    body.entries.map((e: any) => e.op.op),
    ['update_node'],
    'the colour survives, the move does not',
  );
  assert.equal(body.entries[0].kind, 'structural');
  assert.match(body.summary, /coloured red/);
});

test('a colour round-trips to disk and clears cleanly', async () => {
  const graph = await until('colour to reach disk', async () => {
    const g = await readGraphFile();
    const node = g.nodes.find((n: any) => n.id === 'broken');
    return node?.data?.color === 'red' ? g : null;
  });
  assert.equal(graph.nodes.find((n: any) => n.id === 'broken').data.color, 'red');

  await op({ op: 'update_node', id: 'broken', color: 'none' });
  const cleared = await until('colour to clear on disk', async () => {
    const g = await readGraphFile();
    const node = g.nodes.find((n: any) => n.id === 'broken');
    return node && !('color' in node.data) ? g : null;
  });
  assert.ok(!JSON.stringify(cleared).includes('"none"'), 'no sentinel written to the file');
});

test('an unknown colour is refused at the API boundary', async () => {
  const { status, body } = await op({ op: 'update_node', id: 'broken', color: 'crimsonish' });
  assert.equal(status, 400);
  assert.match(body.error, /Unknown colour/);
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

  const { body: filtered } = await api(`/api/changes?since=${base}&actor=all`);
  assert.deepEqual(
    filtered.entries.map((e: any) => e.op.op),
    ['add_edge'],
    'only the change that carried the message survives',
  );

  const { body: full } = await api(`/api/changes?since=${base}&include_layout=true&actor=all`);
  assert.equal(full.entries.length, 4, 'the moves are still on record when asked for');
});

// If the watermark stopped at filtered entries they would stay unseen forever, and
// every later call would re-scan the same pile of moves.
test('consuming advances past repositioning even though it is not returned', async () => {
  await op({ op: 'move_node', id: 'fetch', position: { x: 0, y: 0 } });
  await op({ op: 'move_node', id: 'cache', position: { x: 0, y: 150 } });

  const drained = await api('/api/changes?actor=all');
  assert.ok(
    !drained.body.entries.some((e: any) => e.kind === 'layout'),
    'no layout entries in the response',
  );

  const { body: after } = await api('/api/changes?actor=all');
  assert.deepEqual(after.entries, [], 'the moves were consumed, not left pending');
  assert.equal(after.watermark, after.rev, 'watermark caught up to the latest rev');
});

test('generating a whole diagram costs one rev and reaches disk laid out', async () => {
  const before = (await api('/api/graph')).body.rev;

  const { status } = await op({
    op: 'generate_graph',
    replace: true,
    nodes: [{ label: 'Entry' }, { label: 'Validate' }, { label: 'Emit' }],
    edges: [
      { source: 'entry', target: 'validate' },
      { source: 'validate', target: 'emit' },
    ],
  });
  assert.equal(status, 200);

  const { body: graph } = await api('/api/graph');
  assert.equal(graph.rev, before + 1, 'the whole graph is one rev, not one per node');
  assert.deepEqual(graph.nodes.map((n: any) => n.id), ['entry', 'validate', 'emit']);

  const y = (id: string) => graph.nodes.find((n: any) => n.id === id).position.y;
  assert.ok(y('entry') < y('validate') && y('validate') < y('emit'), 'ranked top to bottom');

  const onDisk = await until('the generated graph to reach disk', async () => {
    const g = await readGraphFile();
    return g.nodes.length === 3 ? g : null;
  });
  assert.ok(onDisk.nodes.every((n: any) => n.position), 'positions persisted');
});

test('a generated diagram shows up in the feed, wipe and all', async () => {
  await api('/api/changes?actor=all'); // drain

  await op({
    op: 'generate_graph',
    replace: true,
    nodes: [{ label: 'Only' }],
    edges: [],
  });

  const { body } = await api('/api/changes?actor=all');
  assert.equal(body.entries.length, 1, 'one entry for the whole generation');
  assert.equal(body.entries[0].kind, 'structural', 'it survives the layout filter');
  assert.match(body.summary, /generated 1 node, 0 edges, replacing what was there/);
});

test('generating over a non-empty diagram is refused at the API boundary', async () => {
  const { status, body } = await op({
    op: 'generate_graph',
    nodes: [{ label: 'Would clobber' }],
    edges: [],
  });
  assert.equal(status, 400);
  assert.match(body.error, /Pass replace: true/);

  const { body: graph } = await api('/api/graph');
  assert.deepEqual(graph.nodes.map((n: any) => n.id), ['only'], 'nothing was discarded');
});

// The two halves of the semantic-layout design, through the real API. An `align` an agent
// cannot issue is useless; one that shows up in the feed buries the message.
test('align is accepted from the agent surface yet filtered from the feed', async () => {
  await op({ op: 'add_node', label: 'Left one' });
  await op({ op: 'add_node', label: 'Left two' });
  await op({ op: 'move_node', id: 'left-one', position: { x: 90, y: 0 } });
  await op({ op: 'move_node', id: 'left-two', position: { x: 300, y: 150 } });
  await api('/api/changes?actor=all'); // drain

  const { status } = await op({ op: 'align', ids: ['left-one', 'left-two'], edge: 'left' });
  assert.equal(status, 200, 'the API accepts it — it carries no coordinate');

  const graph = await until('the alignment to reach disk', async () => {
    const g = await readGraphFile();
    const a = g.nodes.find((n: any) => n.id === 'left-one');
    const b = g.nodes.find((n: any) => n.id === 'left-two');
    // Both must exist first: comparing two undefined x values succeeds vacuously and
    // would let this poll return before anything had reached disk.
    if (!a?.position || !b?.position) return null;
    return a.position.x === b.position.x ? g : null;
  });
  assert.equal(
    graph.nodes.find((n: any) => n.id === 'left-one').position.x,
    graph.nodes.find((n: any) => n.id === 'left-two').position.x,
    'and it actually aligned them',
  );

  const { body: plain } = await api('/api/changes?since=0&actor=all');
  assert.ok(
    !plain.entries.some((e: any) => e.op.op === 'align'),
    'but the default feed treats it as noise, like any other repositioning',
  );

  const { body: full } = await api('/api/changes?since=0&include_layout=true&actor=all');
  const entry = full.entries.find((e: any) => e.op.op === 'align');
  assert.ok(entry, 'it is still on the record when layout is asked for');
  assert.equal(entry.kind, 'layout');
  assert.match(full.summary, /aligned 2 nodes on their left edges/);
});

test('a node dropped on the canvas is NOT filtered out of the feed', async () => {
  await api('/api/changes?actor=all'); // drain
  await op({ op: 'add_node_at', label: 'Dropped here', position: { x: 600, y: 600 } });

  const { body } = await api('/api/changes?actor=all');
  assert.ok(
    body.entries.some((e: any) => e.op.op === 'add_node_at'),
    'creating a node is always part of the message, coordinate or not',
  );
});

test('align refuses ids it cannot use', async () => {
  const ghost = await op({ op: 'align', ids: ['left-one', 'ghost'], edge: 'left' });
  assert.equal(ghost.status, 400);
  assert.match(ghost.body.error, /No node with id "ghost"/);

  const lonely = await op({ op: 'align', ids: ['left-one'], edge: 'left' });
  assert.equal(lonely.status, 400);
  assert.match(lonely.body.error, /at least two nodes/);
});

// Edge colour follows node colour: structural, so it must survive the layout filter.
test('an edge colour round-trips to disk and reaches the feed', async () => {
  await op({ op: 'add_node', label: 'Try' });
  await op({ op: 'add_node', label: 'Fail' });
  await op({ op: 'add_edge', source: 'try', target: 'fail' });
  const base = (await api('/api/graph')).body.rev;

  await op({ op: 'move_node', id: 'try', position: { x: 450, y: 450 } });
  await op({ op: 'update_edge', id: 'try->fail', color: 'red' });

  const { body } = await api(`/api/changes?since=${base}&actor=all`);
  assert.deepEqual(
    body.entries.map((e: any) => e.op.op),
    ['update_edge'],
    'the edge colour survives, the move does not',
  );
  assert.equal(body.entries[0].kind, 'structural');
  assert.match(body.summary, /coloured red/);

  const graph = await until('edge colour to reach disk', async () => {
    const g = await readGraphFile();
    return g.edges.find((e: any) => e.id === 'try->fail')?.color === 'red' ? g : null;
  });
  assert.equal(graph.edges.find((e: any) => e.id === 'try->fail').color, 'red');

  await op({ op: 'update_edge', id: 'try->fail', color: 'none' });
  const cleared = await until('edge colour to clear on disk', async () => {
    const g = await readGraphFile();
    const edge = g.edges.find((e: any) => e.id === 'try->fail');
    return edge && !('color' in edge) ? g : null;
  });
  assert.ok(cleared, 'the colour key is gone rather than set to a sentinel');
});

test('an unknown edge colour is refused at the API boundary', async () => {
  const { status, body } = await op({ op: 'update_edge', id: 'try->fail', color: 'puce' });
  assert.equal(status, 400);
  assert.match(body.error, /Unknown colour/);
});

// A plain debounce restarted its timer on every op, so a stream arriving faster than the
// delay deferred the write for as long as the stream lasted. This drives that stream.
test('a sustained stream of ops cannot postpone the write indefinitely', async () => {
  await op({ op: 'add_node', label: 'Streamed' });

  const started = Date.now();
  let landed = 0;
  // Keep firing inside the 80ms debounce window for well over the 500ms ceiling.
  while (Date.now() - started < 900) {
    await op({ op: 'move_node', id: 'streamed', position: { x: landed % 300, y: 0 } });
    landed++;
    await new Promise((r) => setTimeout(r, 20));
  }

  const graph = JSON.parse(await readFile(graphPath, 'utf8'));
  assert.ok(
    graph.nodes.some((n: any) => n.id === 'streamed'),
    `after ${landed} ops over ${Date.now() - started}ms the node had still not reached disk`,
  );
});

// Sizing is pixels, so it belongs in the same category as a move: persisted and pushed, but
// filtered out of the feed a reader treats as the message.
test('a resize reaches disk and the client, and is filtered from the feed', async () => {
  await op({ op: 'add_node', label: 'Sizable' });
  const base = (await api('/api/graph')).body.rev;
  await op({ op: 'resize_node', id: 'sizable', size: { w: 420, h: 225 } });

  const node = await until('the size to reach disk', async () => {
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    const found = graph.nodes.find((n: any) => n.id === 'sizable');
    return found?.size ? found : null;
  });
  assert.deepEqual(node.size, { w: 420, h: 225 });

  const { body: filtered } = await api(`/api/changes?since=${base}&actor=all`);
  assert.ok(
    !filtered.entries.some((e: any) => e.op.op === 'resize_node'),
    'a resize is layout noise, not part of the message',
  );

  const { body: full } = await api(`/api/changes?since=${base}&include_layout=true&actor=all`);
  const entry = full.entries.find((e: any) => e.op.op === 'resize_node');
  assert.ok(entry, 'but it is still on the record when asked for');
  assert.equal(entry.kind, 'layout');
  assert.match(full.summary, /resized sizable/);
});

/**
 * Attribution.
 *
 * The reason this exists: a real feed of 13 entries was 8 agent ops and 5 human ones, and
 * the agent could only separate them because it still remembered drawing its own. After a
 * context wipe it would have read its own `generate_graph` back as an instruction — a
 * confident misreading, which is worse than returning nothing.
 */

/** Send one op down a websocket, which is how the canvas writes — i.e. as a human. */
async function humanOp(body: Record<string, unknown>): Promise<void> {
  const socket = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise<void>((ok, fail) => {
    socket.on('open', () => ok());
    socket.on('error', fail);
  });
  // Baseline BEFORE sending: read it after and the op may already have landed, so
  // `rev > before` could never become true and this would sit until it timed out.
  const before = (await api('/api/graph')).body.rev;
  socket.send(JSON.stringify({ type: 'op', op: body }));
  await until('the websocket op to be applied', async () => {
    const { body: g } = await api('/api/graph');
    return g.rev > before ? g : null;
  });
  socket.close();
}

test('the transport decides the actor: websocket is human, HTTP is the agent', async () => {
  await op({ op: 'add_node', label: 'By agent' });
  await humanOp({ op: 'add_node', label: 'By human' });

  const { body } = await api('/api/changes?since=0&actor=all');
  const find = (label: string) =>
    body.entries.find((e: any) => e.op.op === 'add_node' && e.op.label === label);

  assert.equal(find('By agent').actor, 'agent', 'an HTTP op is the agent or a script');
  assert.equal(find('By human').actor, 'human', 'a websocket op is the canvas');
});

// The whole point of the feature.
test('a no-argument read returns the human changes and hides the agent own edits', async () => {
  await api('/api/changes?actor=all'); // drain
  await op({ op: 'add_node', label: 'Agent drew this' });
  await humanOp({ op: 'add_node', label: 'Human drew this' });

  const { body } = await api('/api/changes');
  const labels = body.entries.map((e: any) => e.op.label);
  assert.deepEqual(labels, ['Human drew this'], `default is human-only, got ${labels}`);
});

// Same trap as the layout filter: if the watermark stopped at filtered entries, every later
// call would re-scan the same agent ops and never converge.
test('consuming advances past agent entries even though they are not returned', async () => {
  await api('/api/changes?actor=all'); // drain
  await op({ op: 'add_node', label: 'Agent only A' });
  await op({ op: 'add_node', label: 'Agent only B' });

  const drained = await api('/api/changes');
  assert.deepEqual(drained.body.entries, [], 'agent ops are not in a default read');

  const { body: after } = await api('/api/changes?actor=all');
  assert.deepEqual(after.entries, [], 'yet they were consumed, not left pending');
  assert.equal(after.watermark, after.rev, 'watermark caught up past them');
});

test('actor=agent shows only the agent side', async () => {
  await api('/api/changes?actor=all'); // drain
  await op({ op: 'add_node', label: 'Mine' });
  await humanOp({ op: 'add_node', label: 'Theirs' });

  const { body } = await api('/api/changes?since=0&actor=agent');
  const labels = body.entries
    .filter((e: any) => e.op.op === 'add_node')
    .map((e: any) => e.op.label);
  assert.ok(labels.includes('Mine'), 'the agent op is there');
  assert.ok(!labels.includes('Theirs'), 'the human op is not');
});

test('a hand edit of the file counts as human', async () => {
  await api('/api/changes?actor=all'); // drain
  const graph = await until('a node to be on disk', async () => {
    const g = JSON.parse(await readFile(graphPath, 'utf8'));
    return g.nodes.length ? g : null;
  });
  graph.nodes[0].data.label = 'Edited by hand';
  await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');

  const body = await until('the external edit to be recorded', async () => {
    const res = await api('/api/changes?since=0&actor=all');
    return res.body.entries.some((e: any) => e.kind === 'external') ? res.body : null;
  });
  const external = body.entries.filter((e: any) => e.kind === 'external').at(-1);
  assert.equal(external.actor, 'human', 'a person editing the JSON is still a person');

  // And therefore it must survive a default, human-only read.
  const { body: def } = await api('/api/changes?since=0');
  assert.ok(
    def.entries.some((e: any) => e.kind === 'external'),
    'an external edit must reach a default read — it means the picture is stale',
  );
});

/**
 * Upgrading over an existing log.
 *
 * Entries written before actors existed carry no `actor`. They are unattributable rather
 * than anonymous, so every filter keeps them: dropping them would make a real history look
 * empty the first time someone upgraded, which is a worse lie than showing a change that
 * might not have been theirs.
 */
test('a log line written before actors existed is still returned', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'crosspoint-legacy-'));
  const legacyGraph = join(legacyDir, 'graph.json');
  await writeFile(
    legacyGraph,
    JSON.stringify({ rev: 7, nodes: [], edges: [] }, null, 2),
    'utf8',
  );
  // Exactly what an older version wrote: no `actor` key at all.
  await writeFile(
    join(legacyDir, 'graph.ops.jsonl'),
    JSON.stringify({
      rev: 7,
      ts: '2026-08-01T00:00:00.000Z',
      kind: 'structural',
      diagram: 'graph',
      op: { op: 'add_node', label: 'From before' },
    }) + '\n',
    'utf8',
  );

  const port = PORT + 1;
  const legacy = spawn(process.execPath, [entry], {
    env: { ...process.env, CROSSPOINT_PORT: String(port), CROSSPOINT_GRAPH: legacyGraph },
    stdio: 'ignore',
  });
  try {
    await until('the legacy server to listen', async () => {
      try {
        return (await fetch(`http://localhost:${port}/api/graph`)).ok;
      } catch {
        return false;
      }
    });

    const read = async (query: string) => {
      const res = await fetch(`http://localhost:${port}/api/changes${query}`);
      return (await res.json()) as any;
    };

    const asHuman = await read('?since=0');
    assert.equal(asHuman.entries.length, 1, 'a default read must not hide unattributed history');
    assert.equal(asHuman.entries[0].actor, undefined, 'and it stays honestly unattributed');

    const asAgent = await read('?since=0&actor=agent');
    assert.equal(asAgent.entries.length, 1, 'kept by every filter, not just human');

    assert.equal((await read('?since=0&actor=all')).entries.length, 1);
  } finally {
    legacy.kill();
  }
});
