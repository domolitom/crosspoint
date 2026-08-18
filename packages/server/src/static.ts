import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves the built canvas, so normal use is one process on one port.
 *
 * Development still goes through vite for hot reload; this exists so `crosspoint` in some
 * other project needs nothing but node. Same-origin means the canvas's relative `/api` and
 * `location.host` websocket resolve without a proxy.
 */

/** `packages/web/dist`, resolved from this file at `packages/server/dist/static.js`. */
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export const webDir = (): string =>
  resolve(process.env.CROSSPOINT_WEB_DIR ?? DEFAULT_WEB_DIR);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const typeFor = (file: string): string => {
  const dot = file.lastIndexOf('.');
  return (dot >= 0 && TYPES[file.slice(dot)]) || 'application/octet-stream';
};

/**
 * Resolve a URL path to a file inside the root, or null if it escapes.
 *
 * Decoding comes first because `%2e%2e%2f` is `../` and a check against the raw path
 * would miss it entirely.
 *
 * Then `..` is rejected *before* any normalising, which is the part that is easy to get
 * backwards: `path.normalize` collapses a leading `..` on an absolute path, so
 * normalising first turns `/../../etc/passwd` into `/etc/passwd`, joins it back inside
 * the root, and the containment check below can never fail. The guard becomes dead code
 * that looks like it works. A unit test caught precisely that.
 *
 * The containment check stays as a second line of defence, and needs the separator: a
 * bare prefix test would accept a sibling like `/web/dist-evil`.
 */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // Malformed percent-encoding is not a path we should guess at.
  }
  if (decoded.includes('\0')) return null;
  if (decoded.split(/[\\/]+/).includes('..')) return null;

  const candidate = resolve(join(root, normalize(decoded)));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

/**
 * Serve a static file for this request, or return false to let the caller 404.
 *
 * Unknown paths that are not files fall back to `index.html` so a client-side route still
 * loads the canvas.
 */
export async function serveStatic(
  urlPath: string,
  res: ServerResponse,
): Promise<boolean> {
  const root = webDir();
  const wanted = urlPath === '/' ? '/index.html' : urlPath;
  const target = safeJoin(root, wanted);
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  const file = await pick(target, root);
  if (!file) return false;

  res.writeHead(200, { 'Content-Type': typeFor(file) });
  createReadStream(file).pipe(res);
  return true;
}

async function pick(target: string, root: string): Promise<string | null> {
  const direct = await isFile(target);
  if (direct) return target;
  // An asset that does not exist should 404 rather than silently return HTML — serving
  // index.html for a missing script makes the failure look like a parse error instead.
  if (/\.[a-z0-9]+$/i.test(target) && !target.endsWith('.html')) return null;
  const fallback = join(root, 'index.html');
  return (await isFile(fallback)) ? fallback : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
