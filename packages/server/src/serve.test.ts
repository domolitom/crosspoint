import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { safeJoin, webDir } from './static.js';

/**
 * Serving the built canvas, and the `.crosspoint` workspace a project gets.
 *
 * `safeJoin` is unit-tested rather than only driven through HTTP because `new URL()`
 * normalises `..` out of a pathname before the server ever calls it. Every traversal
 * attempt over the wire therefore arrives already flattened, which means an
 * integration test cannot reach the guard at all — it would pass with the guard deleted.
 */

const PORT = 4393;
const BASE = `http://localhost:${PORT}`;
const entry = fileURLToPath(new URL('./index.js', import.meta.url));

let child: ChildProcess;
let parent: string;
let dir: string;

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
  parent = await mkdtemp(join(tmpdir(), 'crosspoint-serve-'));
  // Deliberately does not exist yet: creating it is what we are testing.
  dir = join(parent, '.crosspoint');
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
});

after(() => {
  child?.kill();
});

test('a traversal escape is refused, however it is spelled', () => {
  const root = '/tmp/web-dist';
  for (const attempt of [
    '/../../etc/passwd',
    '/../etc/passwd',
    '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/assets/../../../etc/passwd',
    '/\0/etc/passwd',
    '/%zz',
  ]) {
    assert.equal(safeJoin(root, attempt), null, `"${attempt}" should be refused`);
  }
});

// A prefix test alone would accept a sibling directory whose name merely starts with the
// root, which is why the check requires a separator.
test('a sibling directory sharing the root prefix is refused', () => {
  assert.equal(safeJoin('/tmp/web-dist', '/../web-dist-evil/secret'), null);
});

test('a legitimate path resolves inside the root', () => {
  const root = '/tmp/web-dist';
  assert.equal(safeJoin(root, '/index.html'), join(root, 'index.html'));
  assert.equal(safeJoin(root, '/assets/app.js'), join(root, 'assets', 'app.js'));
  assert.ok(safeJoin(root, '/')!.startsWith(root + sep) || safeJoin(root, '/') === root);
});

test('the canvas is served from the built output', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Crosspoint<\/title>/);
});

test('an asset is served with a real content type', async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  const asset = html.match(/\/assets\/[^"']+\.js/)?.[0];
  assert.ok(asset, 'the built canvas should reference a hashed script');

  const res = await fetch(`${BASE}${asset}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
});

// Serving HTML for a missing script turns a 404 into a syntax error, which is much harder
// to diagnose than the 404 itself.
test('a missing asset 404s rather than falling back to HTML', async () => {
  const res = await fetch(`${BASE}/assets/does-not-exist.js`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/html/);
});

test('an unknown route falls back to the canvas', async () => {
  const res = await fetch(`${BASE}/some/client/route`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
});

// Static serving runs last so it cannot swallow the API.
test('an unknown api route still 404s as json', async () => {
  const res = await fetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

test('the web directory is overridable, for a build in a different place', () => {
  const previous = process.env.CROSSPOINT_WEB_DIR;
  process.env.CROSSPOINT_WEB_DIR = '/tmp/somewhere-else';
  assert.equal(webDir(), '/tmp/somewhere-else');
  if (previous === undefined) delete process.env.CROSSPOINT_WEB_DIR;
  else process.env.CROSSPOINT_WEB_DIR = previous;
});

test('a workspace we create ignores itself', async () => {
  const ignore = await until('the .gitignore to be written', async () => {
    try {
      return await readFile(join(dir, '.gitignore'), 'utf8');
    } catch {
      return null;
    }
  });
  assert.equal(ignore.trim(), '*', 'the folder keeps itself out of the host project git');
});

/*
 * The sidecars live beside the diagrams and are `.json` too. CLAUDE.md already records a
 * naive scan adopting `package.json` as a diagram; this is the same trap one directory in.
 */
test('sidecars and the gitignore are not mistaken for diagrams', async () => {
  await writeFile(join(dir, 'real-one.json'), JSON.stringify({ rev: 0, nodes: [], edges: [] }));
  await writeFile(join(dir, 'decoy.state.json'), '{}');
  await writeFile(join(dir, 'decoy.ops.jsonl'), '');
  await writeFile(join(dir, 'notes.txt'), 'not a diagram');

  const names = await until('the new diagram to be noticed', async () => {
    const body = (await (await fetch(`${BASE}/api/diagrams`)).json()) as any;
    const found = body.diagrams.map((d: any) => d.name);
    return found.includes('real-one') ? found : null;
  });

  for (const rejected of ['decoy.state', 'decoy.ops', '.gitignore', 'gitignore', 'notes']) {
    assert.ok(!names.includes(rejected), `${rejected} must not be listed as a diagram`);
  }
  assert.ok(names.includes('graph') && names.includes('real-one'), `got ${names.join(', ')}`);
});
