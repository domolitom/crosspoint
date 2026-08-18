import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

/**
 * The `crosspoint` command, which is how the tool is used from another project.
 *
 * Lives in the server package because that is where a test runner is already wired into
 * `npm test`, and because starting the server is all the bin does.
 */

const bin = fileURLToPath(new URL('../../../bin/crosspoint.js', import.meta.url));
const entry = fileURLToPath(new URL('./index.js', import.meta.url));

const running: ChildProcess[] = [];

after(() => {
  for (const child of running) child.kill();
});

async function until<T>(label: string, fn: () => Promise<T | null> | T | null, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function start(cwd: string, port: number, args: string[] = []) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, CROSSPOINT_PORT: String(port) },
    stdio: 'ignore',
  });
  running.push(child);
  await until(`the server on ${port}`, async () => {
    try {
      return (await fetch(`http://localhost:${port}/api/graph`)).ok;
    } catch {
      return false;
    }
  });
  return child;
}

// The point of the default: diagrams belong to the project you are standing in, not to
// wherever Crosspoint happens to be installed.
test('with no argument it uses .crosspoint in the current directory', async () => {
  const project = await mkdtemp(join(tmpdir(), 'crosspoint-bin-'));
  await start(project, 4394);

  const ignore = await until('.crosspoint/.gitignore', async () => {
    try {
      return await readFile(join(project, '.crosspoint', '.gitignore'), 'utf8');
    } catch {
      return null;
    }
  });
  assert.equal(ignore.trim(), '*');

  const body = (await (await fetch('http://localhost:4394/api/diagrams')).json()) as any;
  assert.equal(body.active, 'graph');
});

test('an explicit directory argument is honoured', async () => {
  const project = await mkdtemp(join(tmpdir(), 'crosspoint-bin-arg-'));
  await start(project, 4395, ['drawings']);

  const ignore = await until('drawings/.gitignore', async () => {
    try {
      return await readFile(join(project, 'drawings', '.gitignore'), 'utf8');
    } catch {
      return null;
    }
  });
  assert.equal(ignore.trim(), '*');

  // And the default was not created alongside it.
  await assert.rejects(() => readFile(join(project, '.crosspoint', '.gitignore'), 'utf8'));
});

// The server's own argv form. The bin passes the target by env, so this path would
// otherwise go untested — and `npm run dev` and the e2e harness both rely on it.
test('the server accepts a diagrams directory as argv', async () => {
  const project = await mkdtemp(join(tmpdir(), 'crosspoint-argv-'));
  const dir = join(project, 'boards');
  const child = spawn(process.execPath, [entry, dir], {
    env: { ...process.env, CROSSPOINT_PORT: '4396' },
    stdio: 'ignore',
  });
  running.push(child);

  const body = await until('the server to answer', async () => {
    try {
      const res = await fetch('http://localhost:4396/api/diagrams');
      return res.ok ? ((await res.json()) as any) : null;
    } catch {
      return null;
    }
  });
  assert.equal(body.active, 'graph');
  assert.equal((await readFile(join(dir, '.gitignore'), 'utf8')).trim(), '*');
});

test('--help explains itself without starting a server', async () => {
  const out = await new Promise<string>((done) => {
    const child = spawn(process.execPath, [bin, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('close', () => done(text));
  });
  assert.match(out, /Usage: crosspoint/);
  assert.match(out, /\.crosspoint/);
});
