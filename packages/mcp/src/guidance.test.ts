import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Listing tools never reaches the Crosspoint server, so none is started.
const client = new Client({ name: 'guidance-test', version: '0' });

before(async () => {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./index.js', import.meta.url))],
      env: { ...process.env, CROSSPOINT_SERVER: 'http://127.0.0.1:9', CROSSPOINT_NO_SPAWN: '1' },
    }),
  );
});

after(() => client.close());

const RULES: [string, RegExp][] = [
  ['a box budget', /15 boxes/],
  ['detail in a subcanvas', /create_subdiagram/],
  ['short labels, detail in the body', /body/],
  ['LR for sequences', /"LR"/],
  ['colour carries meaning', /colou?r[^.]*meaning/i],
  ['group related boxes', /group/],
  ['check your own work', /check_layout/],
];

test('the server instructions carry the rules for a diagram that reads well', () => {
  const instructions = client.getInstructions() ?? '';
  for (const [rule, pattern] of RULES) assert.match(instructions, pattern, rule);
});

test('check_layout is offered, read-only and scoped to a diagram', async () => {
  const { tools } = await client.listTools();
  const check = tools.find((t) => t.name === 'check_layout');
  assert.ok(check, 'check_layout is listed');
  assert.deepEqual(Object.keys(check.inputSchema.properties ?? {}), ['diagram']);
});

test('generate_graph repeats them where the agent decides what to draw', async () => {
  const { tools } = await client.listTools();
  const generate = tools.find((t) => t.name === 'generate_graph');
  assert.ok(generate, 'generate_graph is listed');
  for (const [rule, pattern] of RULES) assert.match(generate.description ?? '', pattern, rule);
});
