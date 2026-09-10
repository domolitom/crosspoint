import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { AutoStartError, findBin, probe, startServer } from './autostart.js';

/**
 * Auto-start against a real server. The failure this guards is a tool call that reports
 * Crosspoint as broken when the human simply had not started it yet.
 */

const bin = fileURLToPath(new URL('../../../bin/crosspoint.js', import.meta.url));

const started: ChildProcess[] = [];
const pids: number[] = [];
const listening: Server[] = [];

// Everything spawned here is detached, so each is its own process group — killing the group
// takes the bin and the server it started.
after(() => {
  for (const pid of [...pids, ...started.map((c) => c.pid!)]) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  for (const server of listening) server.close();
});

async function project() {
  return await mkdtemp(join(tmpdir(), 'crosspoint-autostart-'));
}

test('it starts a server when nothing is listening', async () => {
  const cwd = await project();
  const port = 4451;
  const url = `http://localhost:${port}`;

  assert.equal(await probe(url), 'closed');

  const previous = process.cwd();
  process.chdir(cwd);
  let pid: number | null;
  try {
    pid = await startServer(url, { bin });
  } finally {
    process.chdir(previous);
  }

  assert.ok(pid, 'it should report the pid it started');
  pids.push(pid);
  assert.equal(await probe(url), 'crosspoint');

  // Diagrams belong to the directory the agent is standing in, not to wherever the MCP
  // server happens to be installed.
  assert.ok(existsSync(join(cwd, '.crosspoint')));
});

test('it adopts a server that is already running', async () => {
  const cwd = await project();
  const port = 4452;
  const url = `http://localhost:${port}`;

  const child = spawn(process.execPath, [bin], {
    cwd,
    env: { ...process.env, CROSSPOINT_PORT: String(port) },
    stdio: 'ignore',
    detached: true,
  });
  started.push(child);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await probe(url)) !== 'crosspoint') {
    await new Promise((r) => setTimeout(r, 100));
  }

  // No bin at all: if this resolves, it adopted rather than spawned.
  assert.equal(await startServer(url, { bin: null }), null);
  assert.equal(await probe(url), 'crosspoint');
});

test('it refuses to adopt a foreign server on the port', async () => {
  const port = 4453;
  const url = `http://localhost:${port}`;

  const other = createServer((_req, res) => res.end('not crosspoint'));
  listening.push(other);
  await new Promise<void>((done) => other.listen(port, done));

  assert.equal(await probe(url), 'foreign');
  await assert.rejects(
    () => startServer(url, { bin }),
    (err: Error) => err instanceof AutoStartError && /not Crosspoint is listening/.test(err.message),
  );
});

test('CROSSPOINT_NO_SPAWN turns it into an explanation', async () => {
  await assert.rejects(
    () => startServer('http://localhost:4454', { bin, allowed: false }),
    (err: Error) => err instanceof AutoStartError && /CROSSPOINT_NO_SPAWN/.test(err.message),
  );
});

test('a remote server is never spawned locally', async () => {
  await assert.rejects(
    () => startServer('http://example.invalid:4000', { bin }),
    (err: Error) => err instanceof AutoStartError && /not this machine/.test(err.message),
  );
});

test('a missing CLI says how to start one', async () => {
  await assert.rejects(
    () => startServer('http://localhost:4455', { bin: null }),
    (err: Error) => err instanceof AutoStartError && /npx crosspoint/.test(err.message),
  );
});

test('findBin locates the CLI from the checkout', () => {
  assert.equal(findBin(), bin);
});
