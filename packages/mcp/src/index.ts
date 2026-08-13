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
  'get_changes',
  {
    title: 'Get changes',
    description:
      'Read what the human changed in the diagram, in the order they changed it. This ' +
      'is how an edit becomes a request: they rearrange the graph, then ask you to act ' +
      'on it, and this tool tells you what "it" was.\n\n' +
      'Call it with NO arguments to get everything since you last looked — the server ' +
      'remembers where you got to, so this keeps working across a new session or after ' +
      'your context is compacted. Doing so consumes those changes: the next no-argument ' +
      'call returns only what is newer.\n\n' +
      'Pass since_rev instead for a repeatable query that does not consume, which is ' +
      'what you want when re-reading something you have already seen.\n\n' +
      'Repositioning is left out by default — where a box sits is rarely the message, ' +
      'and on a real session it was 18 of 20 entries, burying the two that mattered. ' +
      'What you get is tagged `structural` (nodes and edges) or `external` (the file was ' +
      'edited outside the app, so re-read the graph rather than trusting your picture).',
    inputSchema: {
      since_rev: z
        .number()
        .int()
        .optional()
        .describe(
          'Return changes after this rev without consuming them. Omit to get everything ' +
            'unseen and advance your position.',
        ),
      include_layout: z
        .boolean()
        .optional()
        .describe(
          'Include repositioning. Rarely useful — ask only when the question is ' +
            'genuinely about where things sit, such as which nodes were grouped together.',
        ),
    },
  },
  async ({ since_rev, include_layout }) => {
    const params = new URLSearchParams();
    if (since_rev !== undefined) params.set('since', String(since_rev));
    if (include_layout) params.set('include_layout', 'true');
    const query = params.toString();
    return ok(await call(`/api/changes${query ? `?${query}` : ''}`));
  },
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
  'reconnect_edge',
  {
    title: 'Reconnect edge',
    description:
      'Move an existing edge to different endpoints, keeping its label. Use this rather ' +
      'than delete_edge plus add_edge when an arrow is pointing at the wrong node — it is ' +
      'one change instead of two, and the label survives. Note the edge id changes: ids ' +
      'are derived from their endpoints, so an edge that now runs elsewhere gets a new ' +
      'one. Read it back from the returned graph rather than reusing the old id.',
    inputSchema: {
      id: z.string().describe('Id of the edge to move.'),
      source: z.string().describe('Id of the node the edge should now leave.'),
      target: z.string().describe('Id of the node the edge should now enter.'),
    },
  },
  async ({ id, source, target }) =>
    ok(await applyOp({ op: 'reconnect_edge', id, source, target })),
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
