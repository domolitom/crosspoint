import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Start the Crosspoint server when a tool call finds nothing listening.
 *
 * The MCP server is a thin client of the HTTP API, so without this every tool call fails
 * whenever the human forgot to start the canvas — and to the agent that is indistinguishable
 * from Crosspoint being broken.
 */

const require = createRequire(import.meta.url);

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type Probe = 'crosspoint' | 'foreign' | 'closed';

/** Ask what is on the port. `foreign` matters: we must not adopt someone else's server. */
export async function probe(server: string, timeoutMs = 1500): Promise<Probe> {
  try {
    const res = await fetch(`${server}/api/graph`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'foreign';
    const body: unknown = await res.json().catch(() => null);
    return body && Array.isArray((body as { nodes?: unknown }).nodes) ? 'crosspoint' : 'foreign';
  } catch {
    return 'closed';
  }
}

/**
 * The `crosspoint` CLI, or null if it is not reachable from here.
 *
 * The monorepo checkout is tried first so development spawns the working tree rather than
 * whatever version npm happened to install.
 */
export function findBin(): string | null {
  const sibling = fileURLToPath(new URL('../../../bin/crosspoint.js', import.meta.url));
  if (existsSync(sibling)) return sibling;
  try {
    return require.resolve('crosspoint/bin/crosspoint.js');
  } catch {
    return null;
  }
}

export class AutoStartError extends Error {}

export interface AutoStartOptions {
  bin?: string | null;
  allowed?: boolean;
  timeoutMs?: number;
  /** Injected so tests do not have to guess how long a real boot takes. */
  pollMs?: number;
}

async function waitForServer(server: string, timeoutMs: number, pollMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe(server)) === 'crosspoint') return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new AutoStartError(
    `Crosspoint was started but did not answer on ${server} within ${Math.round(
      timeoutMs / 1000,
    )}s.`,
  );
}

/**
 * Bring a server up at `server`, or explain why that is impossible. Returns the pid it
 * started, or null when it adopted one that was already there.
 *
 * Adopting is the common case, and starting a second server on a taken port would only fail.
 */
export async function startServer(
  server: string,
  options: AutoStartOptions = {},
): Promise<number | null> {
  const { allowed = true, timeoutMs = 20_000, pollMs = 250 } = options;

  const found = await probe(server);
  if (found === 'crosspoint') return null;
  if (found === 'foreign') {
    throw new AutoStartError(
      `Something that is not Crosspoint is listening on ${server}. Free the port, or point ` +
        'CROSSPOINT_SERVER at another one.',
    );
  }

  const url = new URL(server);
  if (!LOCAL.has(url.hostname)) {
    throw new AutoStartError(
      `Crosspoint is not answering on ${server}, and that is not this machine, so it cannot ` +
        'be started from here.',
    );
  }

  if (!allowed) {
    throw new AutoStartError(
      `Crosspoint is not running on ${server} and CROSSPOINT_NO_SPAWN is set. Start it with ` +
        '`npx crosspoint`.',
    );
  }

  const bin = options.bin === undefined ? findBin() : options.bin;
  if (!bin) {
    throw new AutoStartError(
      `Crosspoint is not running on ${server} and the CLI is not installed beside this MCP ` +
        'server, so it cannot be started. Run `npx crosspoint` in your project.',
    );
  }

  // Detached, so the canvas the human is looking at survives the agent restarting. Its
  // stdio is dropped rather than inherited: on this transport stdout is the MCP protocol.
  const child = spawn(process.execPath, [bin], {
    cwd: process.cwd(),
    env: { ...process.env, CROSSPOINT_PORT: url.port || '4000' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  await waitForServer(server, timeoutMs, pollMs);
  return child.pid ?? null;
}

let pending: Promise<unknown> | null = null;

/** One attempt per process, shared by every tool call that races into it. */
export function ensureServer(server: string, options: AutoStartOptions = {}) {
  pending ??= startServer(server, options).catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
