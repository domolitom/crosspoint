#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fail with the actual cause before a build can fail with a symptom.
 *
 * Without `npm install`, `tsc` reports a dozen "Cannot find module 'node:test'" and
 * "Cannot find name 'process'" errors — every one of which is really "no dependencies and
 * no @types/node". That reads as a broken repository rather than a missing step, and it is
 * the first thing a newcomer sees. `bin/crosspoint.js` takes the same line about a missing
 * build.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  problems.push(
    `Node ${process.versions.node} is too old — Crosspoint needs 22 or newer.\n` +
      '  The build uses features that simply are not there before 22.',
  );
}

if (!existsSync(join(root, 'node_modules'))) {
  problems.push('Dependencies are not installed. Run this first:\n\n  npm install\n');
}

if (problems.length > 0) {
  console.error(`\ncrosspoint: ${problems.join('\n\n')}`);
  process.exit(1);
}
