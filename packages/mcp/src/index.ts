#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Crosspoint MCP server — the agent's door into the graph.
 *
 * Every tool here is structural. None of them accepts a coordinate, and `get_graph`
 * omits geometry unless explicitly asked for. That is deliberate and load-bearing:
 *
 *  - Positions are meaningless to an agent as *input* — `x: 342` says nothing about what
 *    a diagram means, and spends tokens saying it.
 *  - Positions are precious as *stored data* — they are the human's payload, the thing
 *    dragging produces and the reason this format is not Mermaid.
 *
 * Since the agent cannot express a position through this API, it cannot clobber one.
 * That is a stronger guarantee than asking an agent to be careful with a whole-file
 * rewrite, which is exactly what direct JSON editing would require.
 */

const SERVER = process.env.CROSSPOINT_SERVER ?? 'http://localhost:4000';

const server = new McpServer({ name: 'crosspoint', version: '0.1.0' });

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${SERVER}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

const applyOp = (op: Record<string, unknown>) =>
  call('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op }),
  });

const ok = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

server.registerTool(
  'get_graph',
  {
    title: 'Get graph',
    description:
      'Read the diagram as structure: nodes with their ids and labels, and the edges ' +
      'between them. Node coordinates are omitted by default because they carry no ' +
      'meaning for reasoning about the diagram. Pass include_positions only if you ' +
      'genuinely need geometry (for example to report where something sits on screen).',
    inputSchema: {
      include_positions: z
        .boolean()
        .optional()
        .describe('Include x/y coordinates. Rarely needed; defaults to false.'),
    },
  },
  async ({ include_positions }) =>
    ok(await call(include_positions ? '/api/graph' : '/api/graph/structural')),
);

server.registerTool(
  'add_node',
  {
    title: 'Add node',
    description:
      'Add a node. You do not choose where it goes — the server places it clear of the ' +
      'existing nodes and the human can drag it from there. Use `near` to express intent ' +
      'about placement ("below the auth service") instead of coordinates. Returns the ' +
      'new graph structure including the generated id.',
    inputSchema: {
      label: z.string().min(1).describe('Text shown on the node.'),
      near: z
        .string()
        .optional()
        .describe('Id of an existing node to place this one beneath.'),
    },
  },
  async ({ label, near }) => ok(await applyOp({ op: 'add_node', label, near })),
);

server.registerTool(
  'add_edge',
  {
    title: 'Add edge',
    description: 'Connect two existing nodes by id. Fails if either id is unknown.',
    inputSchema: {
      source: z.string().describe('Id of the node the edge leaves.'),
      target: z.string().describe('Id of the node the edge enters.'),
      label: z.string().optional().describe('Optional text on the edge.'),
    },
  },
  async ({ source, target, label }) =>
    ok(await applyOp({ op: 'add_edge', source, target, label })),
);

server.registerTool(
  'update_node',
  {
    title: 'Update node',
    description:
      "Change a node's label. Its position is untouched — relabelling never moves a node " +
      'the human has placed.',
    inputSchema: {
      id: z.string().describe('Id of the node to change.'),
      label: z.string().min(1).describe('New label text.'),
    },
  },
  async ({ id, label }) => ok(await applyOp({ op: 'update_node', id, label })),
);

server.registerTool(
  'update_edge',
  {
    title: 'Update edge',
    description: "Change an edge's label.",
    inputSchema: {
      id: z.string().describe('Id of the edge to change.'),
      label: z.string().describe('New label text; pass an empty string to clear it.'),
    },
  },
  async ({ id, label }) => ok(await applyOp({ op: 'update_edge', id, label })),
);

server.registerTool(
  'delete_node',
  {
    title: 'Delete node',
    description: 'Remove a node and any edges attached to it.',
    inputSchema: { id: z.string().describe('Id of the node to remove.') },
  },
  async ({ id }) => ok(await applyOp({ op: 'delete_node', id })),
);

server.registerTool(
  'delete_edge',
  {
    title: 'Delete edge',
    description: 'Remove a single edge, leaving both its nodes in place.',
    inputSchema: { id: z.string().describe('Id of the edge to remove.') },
  },
  async ({ id }) => ok(await applyOp({ op: 'delete_edge', id })),
);

await server.connect(new StdioServerTransport());
