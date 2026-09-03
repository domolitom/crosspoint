import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';

/**
 * A real Crosspoint stack, for filming.
 *
 * Deliberately not the e2e harness. That one exists to *test*: it takes fixed ports, hands
 * back a bare page, and kills everything with SIGKILL. A recorder needs its own ports so it
 * can run while the suite or the dev server is up, and it needs a browser context with
 * video recording turned on, which the harness never creates. Coupling the film to test
 * infrastructure would also mean a harness change silently breaks the film.
 */

export const SERVER_PORT = 4600;
export const WEB_PORT = 5600;
export const API = `http://localhost:${SERVER_PORT}`;
export const CANVAS = `http://localhost:${WEB_PORT}`;

/** The frame the film is shot at. Displayed 1:1 in the composition, so it must not change. */
export const SHOT = { width: 1520, height: 950 };

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The full Chromium from Playwright's cache, not the headless shell.
 *
 * The shell is enough to drive a page but this needs `recordVideo`, and the film wants real
 * font rasterisation and compositing rather than the stripped-down build.
 */
function resolveChromium(): string {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), 'Library', 'Caches', 'ms-playwright');

  const candidates = isDir(cache)
    ? readdirSync(cache)
        .filter((e) => /^chromium-\d+$/.test(e))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
        .flatMap((build) => {
          const dir = join(cache, build);
          return isDir(dir)
            ? readdirSync(dir)
                .filter((arch) => arch.startsWith('chrome-'))
                .flatMap((arch) => {
                  const base = join(dir, arch);
                  return readdirSync(base)
                    .filter((app) => app.endsWith('.app'))
                    .map((app) => join(base, app, 'Contents', 'MacOS', app.replace('.app', '')));
                })
            : [];
        })
        .filter(existsSync)
    : [];

  if (candidates.length === 0) {
    throw new Error(
      `No cached Playwright Chromium found under ${cache}.\n` +
        'Install one with:  npx playwright install chromium',
    );
  }
  return candidates[0];
}

/**
 * ffmpeg, from Remotion rather than from Playwright.
 *
 * Playwright ships a deliberately minimal build — `-encoders` lists libvpx VP8 and nothing
 * else, because encoding its own recordings is all it needs. Asking it for libx264 fails
 * with a bare exit code 8. Remotion's compositor carries a full build, since rendering an
 * h264 mp4 is its whole job.
 */
export function resolveFfmpeg(): string {
  const candidates = [
    `@remotion/compositor-${process.platform}-${process.arch}`,
    `@remotion/compositor-${process.platform}-${process.arch}-eabi`,
  ].map((pkg) => join(repoRoot, 'demo', 'node_modules', pkg, 'ffmpeg'));

  const found = candidates.filter(existsSync);
  if (found.length === 0) {
    throw new Error(
      `No Remotion ffmpeg found. Looked for:\n  ${candidates.join('\n  ')}\n` +
        'Run `npm install` in demo/.',
    );
  }
  return found[0];
}

async function until(label: string, fn: () => Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

export interface Set {
  browser: Browser;
  dir: string;
  op(body: Record<string, unknown>, diagram?: string): Promise<any>;
  graph(diagram?: string): Promise<any>;
  changes(query?: string): Promise<any>;
  createDiagram(name: string): Promise<any>;
  stop(): Promise<void>;
}

/** Boot the built server, vite, and a browser. Nothing here touches the repo's own graph. */
export async function startSet(): Promise<Set> {
  const dir = await mkdtemp(join(tmpdir(), 'crosspoint-film-'));
  const children: ChildProcess[] = [];

  children.push(
    spawn(process.execPath, [join(repoRoot, 'packages/server/dist/index.js'), dir], {
      env: { ...process.env, CROSSPOINT_PORT: String(SERVER_PORT) },
      stdio: 'ignore',
    }),
  );
  await until('the server to listen', async () => (await fetch(`${API}/api/graph`)).ok);

  children.push(
    spawn(
      join(repoRoot, 'node_modules/.bin/vite'),
      ['--port', String(WEB_PORT), '--strictPort'],
      {
        cwd: join(repoRoot, 'packages/web'),
        env: { ...process.env, CROSSPOINT_SERVER: API },
        stdio: 'ignore',
      },
    ),
  );
  await until('vite to serve the canvas', async () => (await fetch(CANVAS)).ok);

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
  });

  const json = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${API}${path}`, init);
    return res.json();
  };

  return {
    browser,
    dir,
    op: (body, diagram) =>
      json('/api/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diagram ? { op: body, diagram } : { op: body }),
      }),
    graph: (diagram) => json(`/api/graph${diagram ? `?diagram=${diagram}` : ''}`),
    changes: (query = '') => json(`/api/changes${query}`),
    createDiagram: (name) =>
      json('/api/diagrams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    stop: async () => {
      await browser.close().catch(() => {});
      for (const child of children) child.kill('SIGKILL');
    },
  };
}
