#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Start Crosspoint against the project you are standing in.
 *
 * Diagrams belong to the project being worked on, so the default target is `.crosspoint`
 * relative to the current directory rather than anywhere inside this repo. One process
 * serves both the API and the canvas, so using it elsewhere needs nothing but node.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = resolve(root, 'packages/server/dist/index.js');
const canvasEntry = resolve(root, 'packages/web/dist/index.html');

const args = process.argv.slice(2);
if (args[0] === '-h' || args[0] === '--help') {
  console.log(`Usage: crosspoint [diagrams-dir]

Serves the canvas and the API on one port.

  diagrams-dir   Where diagrams live. Defaults to ./.crosspoint

Environment:
  CROSSPOINT_PORT   Port to listen on (default 4000)
`);
  process.exit(0);
}

// A missing build is the likeliest first-run failure, and a module-not-found stack trace
// tells the user nothing about what to do next.
const missing = [
  [serverEntry, 'the server'],
  [canvasEntry, 'the canvas'],
].filter(([path]) => !existsSync(path));

if (missing.length > 0) {
  console.error(
    `crosspoint: ${missing.map(([, what]) => what).join(' and ')} ` +
      `${missing.length > 1 ? 'have' : 'has'} not been built.\n\n` +
      `Run this once, in ${root}:\n\n  npm install && npm run build\n`,
  );
  process.exit(1);
}

const target = resolve(process.cwd(), args[0] ?? '.crosspoint');
const port = process.env.CROSSPOINT_PORT ?? '4000';

// The server prints the URL along with the diagrams directory, so no line here.
const child = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, CROSSPOINT_DIAGRAMS: target, CROSSPOINT_PORT: port },
  stdio: 'inherit',
});

// Forward signals so Ctrl-C reaches the server and it can flush before exiting.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
