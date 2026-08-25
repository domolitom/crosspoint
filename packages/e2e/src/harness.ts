import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * Boots an isolated Crosspoint stack and a headless browser for it.
 *
 * Isolated on purpose: the suite must never touch the repo's `graph.json` or assume the
 * developer's dev server is running. Each run gets its own graph file in a temp dir and
 * its own ports, so running the tests can neither destroy your working diagram nor be
 * confused by whatever state it happens to be in.
 */

/** Deliberately odd, to avoid colliding with the dev stack (4000/5173) or other suites. */
export const SERVER_PORT = 4477;
export const WEB_PORT = 5477;
export const API = `http://localhost:${SERVER_PORT}`;
export const CANVAS = `http://localhost:${WEB_PORT}`;

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Where Playwright caches the browsers it downloads.
 *
 * One directory per platform, and `PLAYWRIGHT_BROWSERS_PATH` overrides all of them — CI
 * images often set it to keep the cache off the home directory.
 */
export function browserCache(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override) return override;

  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Local', 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright');
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Find the cached headless shell Playwright downloads.
 *
 * `playwright-core` ships no browser of its own, so we borrow the one in the shared
 * cache. Failing with instructions beats failing with a stack trace from deep inside
 * the launcher.
 *
 * The binary sits one level down in a directory named for the platform and architecture —
 * `chrome-headless-shell-mac-arm64`, `-linux64`, `-win64`. Searching for that prefix beats
 * spelling out every name for the same file, which is how this came to be macOS-only and
 * to fail on the first Linux contributor rather than on the author's machine.
 */
export function resolveHeadlessShell(): string {
  const cache = browserCache();
  const exe = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';

  const candidates = isDir(cache)
    ? readdirSync(cache)
        .filter((entry) => entry.startsWith('chromium_headless_shell'))
        .sort()
        .reverse()
        .flatMap((entry) => {
          const build = join(cache, entry);
          return isDir(build)
            ? readdirSync(build)
                .filter((arch) => arch.startsWith('chrome-headless-shell-'))
                .map((arch) => join(build, arch, exe))
            : [];
        })
        .filter((path) => existsSync(path))
    : [];

  if (candidates.length === 0) {
    throw new Error(
      'No cached Playwright headless shell found.\n' +
        `Looked under ${cache} (platform: ${process.platform}).\n` +
        'Install one with:  npx playwright install chromium --only-shell',
    );
  }
  return candidates[0];
}

export async function until<T>(
  label: string,
  fn: () => Promise<T | null | false> | T | null | false,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for: ${label}${last ? ` (last error: ${last})` : ''}`);
}

export interface Stack {
  browser: Browser;
  page: Page;
  graphPath: string;
  /** Full graph including geometry — the canvas view. Names a diagram, or the active one. */
  graph(diagram?: string): Promise<any>;
  /** Apply an op the way the MCP server would, over HTTP. */
  op(body: Record<string, unknown>, diagram?: string): Promise<{ status: number; body: any }>;
  /** Create a diagram. Does not switch to it, matching the server's behaviour. */
  createDiagram(name: string): Promise<{ status: number; body: any }>;
  stop(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const dir = await mkdtemp(join(tmpdir(), 'crosspoint-e2e-'));
  const graphPath = join(dir, 'graph.json');
  const children: ChildProcess[] = [];

  const server = spawn(process.execPath, [join(repoRoot, 'packages/server/dist/index.js')], {
    env: { ...process.env, CROSSPOINT_PORT: String(SERVER_PORT), CROSSPOINT_GRAPH: graphPath },
    stdio: 'ignore',
  });
  children.push(server);

  await until('the test server to listen', async () => (await fetch(`${API}/api/graph`)).ok);

  // strictPort so a busy port fails loudly instead of silently serving elsewhere and
  // leaving every assertion mysteriously testing the wrong thing.
  const web = spawn(
    join(repoRoot, 'node_modules/.bin/vite'),
    ['--port', String(WEB_PORT), '--strictPort'],
    {
      cwd: join(repoRoot, 'packages/web'),
      env: { ...process.env, CROSSPOINT_SERVER: API },
      stdio: 'ignore',
    },
  );
  children.push(web);

  await until('vite to serve the canvas', async () => (await fetch(CANVAS)).ok, 30_000);

  const browser = await chromium.launch({ executablePath: resolveHeadlessShell() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const stack: Stack = {
    browser,
    page,
    graphPath,
    graph: async (diagram) =>
      (
        await fetch(
          `${API}/api/graph${diagram ? `?diagram=${encodeURIComponent(diagram)}` : ''}`,
        )
      ).json(),
    op: async (body, diagram) => {
      const res = await fetch(`${API}/api/op`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diagram ? { op: body, diagram } : { op: body }),
      });
      return { status: res.status, body: await res.json() };
    },
    createDiagram: async (name) => {
      const res = await fetch(`${API}/api/diagrams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return { status: res.status, body: await res.json() };
    },
    stop: async () => {
      await browser.close().catch(() => {});
      // SIGKILL rather than SIGTERM: a stray process holding a port has broken a run in
      // this project before, and a polite request that is ignored is worse than none.
      for (const child of children) child.kill('SIGKILL');
      await until(
        'ports to be released',
        async () => {
          for (const url of [`${API}/api/graph`, CANVAS]) {
            try {
              await fetch(url);
              return false;
            } catch {
              /* refused, which is what we want */
            }
          }
          return true;
        },
        10_000,
      ).catch(() => {});
    },
  };

  return stack;
}

/** Open the canvas and wait until it has rendered the graph the server holds. */
export async function openCanvas(stack: Stack, expectNodes = 0): Promise<void> {
  await stack.page.goto(CANVAS, { waitUntil: 'domcontentloaded' });
  await until('the canvas to report a live connection', async () =>
    (await stack.page.locator('.status.ok').count()) > 0,
  );
  if (expectNodes > 0) {
    await until(
      `${expectNodes} nodes to render`,
      async () => (await stack.page.locator('.react-flow__node').count()) >= expectNodes,
    );
  }
  await settleViewport(stack.page);
}

/**
 * Wait until React Flow has stopped moving the viewport.
 *
 * `fitView` animates, and a diagram switch re-fits. Measured: across a switch the transform
 * moves for ~250ms and the first node's x travels 102 -> 562. A click computed from a bounding
 * box taken during that window lands ~460px from where the node ends up, and the click is
 * simply discarded — which reads as "selection is broken" or a silent timeout, not as a race.
 * Three flaky tests all had this one cause.
 *
 * Cheap when nothing is moving: on a settled canvas it returns after three quick samples.
 */
export async function settleViewport(page: Page): Promise<void> {
  let previous: string | null = null;
  let stable = 0;
  await until('the viewport to stop moving', async () => {
    const now = await page.evaluate(() => {
      const vp = document.querySelector('.react-flow__viewport');
      return vp ? getComputedStyle(vp).transform : 'none';
    });
    stable = now === previous ? stable + 1 : 0;
    previous = now;
    return stable >= 3;
  });
}

/** Centre of a node in page coordinates, for driving the mouse. */
export async function nodeCentre(page: Page, id: string) {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`Node ${id} has no bounding box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drag from one point to another, with intermediate steps so d3-drag registers it. */
export async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifier?: 'Shift' | 'Meta',
) {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}
