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

/**
 * `diagram` writes somewhere other than what the human is looking at.
 *
 * That is what makes detailing a step non-disruptive: the sub-plan is built in its own
 * diagram while their canvas stays exactly where it was.
 */
const applyOp = (op: Record<string, unknown>, diagram?: string) =>
  call('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(diagram ? { op, diagram } : { op }),
  });

const diagramParam = z
  .string()
  .optional()
  .describe(
    'Diagram to act on. Defaults to the one the human is looking at. Naming one writes ' +
      'there WITHOUT moving their view — this is how you fill in a subcanvas.',
  );

/**
 * Colour is meaning, not decoration — it is the one presentational thing on the agent
 * surface, and it earns its place because a coloured node is usually a statement.
 */
const colorSchemaFor = (subject: 'node' | 'edge') =>
  z
    .enum(['slate', 'amber', 'red', 'green', 'blue', 'violet', 'none'])
    .describe(
      `Colour the ${subject}, by name. Use it to say something — amber for "needs ` +
        'attention", red for "broken", green for "done" — not to decorate. Pass "none" to ' +
        'clear it. Nodes and edges share one palette, so the same name means the same ' +
        'thing on either, and the human sees those six colours in their own palette.',
    );

const colorSchema = colorSchemaFor('node');
const edgeColorSchema = colorSchemaFor('edge');

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
      'genuinely need geometry (for example to report where something sits on screen).\n\n' +
      'A node with a `subcanvas` field has its own diagram behind it holding its detail — ' +
      'pass that name as `diagram` here to read it.',
    inputSchema: {
      include_positions: z
        .boolean()
        .optional()
        .describe('Include x/y coordinates. Rarely needed; defaults to false.'),
      diagram: z
        .string()
        .optional()
        .describe('Diagram to read. Defaults to the active one. Reading never switches views.'),
    },
  },
  async ({ include_positions, diagram }) => {
    const base = include_positions ? '/api/graph' : '/api/graph/structural';
    const query = diagram ? `?diagram=${encodeURIComponent(diagram)}` : '';
    return ok(await call(`${base}${query}`));
  },
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
      color: colorSchema.optional(),
    },
  },
  async ({ label, near, color }) => ok(await applyOp({ op: 'add_node', label, near, color })),
);

server.registerTool(
  'generate_graph',
  {
    title: 'Generate graph',
    description:
      'Build a whole diagram in one call. This is the tool to reach for when asked to ' +
      'visualise something — an algorithm, a control flow graph, a plan with steps — ' +
      'rather than calling add_node and add_edge dozens of times.\n\n' +
      'You supply structure only: nodes with labels, and edges between them. The server ' +
      'runs a hierarchical layout engine, so a forty-node graph arrives readable instead ' +
      'of as a staircase. You express no coordinates here, exactly as everywhere else.\n\n' +
      'Node ids default to the slugified label ("Parse input" becomes "parse-input"), and ' +
      'edges refer to those ids. If two nodes would share an id you must give at least ' +
      'one an explicit `id`: the call is refused rather than guessing, because otherwise ' +
      'an edge naming that id would silently attach to the wrong node.\n\n' +
      'It refuses to overwrite a diagram that already has nodes. Pass replace: true when ' +
      'you genuinely mean to discard what is there — a human may have spent real time on ' +
      'it. Prefer generating into an empty diagram when you can.',
    inputSchema: {
      nodes: z
        .array(
          z.object({
            label: z.string().min(1).describe('Text shown on the node.'),
            id: z
              .string()
              .optional()
              .describe('Override the id derived from the label. Needed when labels collide.'),
            color: colorSchema.optional(),
          }),
        )
        .min(1)
        .describe('Every node in the diagram. Order does not matter; layout is computed.'),
      edges: z
        .array(
          z.object({
            source: z.string().describe('Id of the node the edge leaves.'),
            target: z.string().describe('Id of the node the edge enters.'),
            label: z.string().optional().describe('Optional text on the edge.'),
            color: edgeColorSchema.optional(),
          }),
        )
        .describe('Edges between the nodes above, by id. Pass an empty array for none.'),
      replace: z
        .boolean()
        .optional()
        .describe('Discard the existing diagram. Required if it has any nodes.'),
      diagram: diagramParam,
    },
  },
  async ({ nodes, edges, replace, diagram }) =>
    ok(await applyOp({ op: 'generate_graph', nodes, edges, replace }, diagram)),
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
      color: edgeColorSchema.optional(),
    },
  },
  async ({ source, target, label, color }) =>
    ok(await applyOp({ op: 'add_edge', source, target, label, color })),
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
      "Change a node's label, its colour, or both. Its position is untouched — neither " +
      'relabelling nor recolouring moves a node the human has placed. Pass whichever ' +
      'fields you want to change; omitting one leaves it alone.',
    inputSchema: {
      id: z.string().describe('Id of the node to change.'),
      label: z.string().min(1).optional().describe('New label text. Omit to keep the current one.'),
      color: colorSchema.optional(),
      subcanvas: z
        .string()
        .optional()
        .describe(
          'Name of a diagram holding this node\'s detail. Prefer create_subdiagram, which ' +
            'makes the diagram and links it in one step. Pass "none" to unlink without ' +
            'deleting the diagram.',
        ),
      diagram: diagramParam,
    },
  },
  async ({ id, label, color, subcanvas, diagram }) =>
    ok(await applyOp({ op: 'update_node', id, label, color, subcanvas }, diagram)),
);

server.registerTool(
  'update_edge',
  {
    title: 'Update edge',
    description:
      "Change an edge's label or colour. Both are optional, so pass only what you mean " +
      'to change — setting a colour leaves the label alone and vice versa.',
    inputSchema: {
      id: z.string().describe('Id of the edge to change.'),
      label: z
        .string()
        .optional()
        .describe('New label text; pass an empty string to clear it.'),
      color: edgeColorSchema.optional(),
    },
  },
  async ({ id, label, color }) => ok(await applyOp({ op: 'update_edge', id, label, color })),
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

/**
 * The escape hatch in the coordinates invariant.
 *
 * These are the only tools here that move anything, and they are allowed because they name
 * intent rather than geometry — the server computes the pixels. Note they are still tagged
 * as repositioning in the change feed, so using one does not clutter what the human's next
 * `get_changes` reports.
 */
const TIDY_CAVEAT =
  ' Only tidy when asked. Rearranging someone\'s diagram because you think it looks ' +
  'untidy is exactly the kind of unrequested change the layout rules here exist to prevent.';

server.registerTool(
  'align',
  {
    title: 'Align nodes',
    description:
      'Line up two or more nodes on a shared edge or centre line. You do not compute the ' +
      'positions — name the intent and the server resolves it, using each node\'s real ' +
      'size so wide and narrow boxes centre correctly. Nodes you do not list never move. ' +
      'Ids come from get_graph.' +
      TIDY_CAVEAT,
    inputSchema: {
      ids: z
        .array(z.string())
        .min(2)
        .describe('Ids of the nodes to line up. At least two — aligning one means nothing.'),
      edge: z
        .enum(['left', 'right', 'top', 'bottom', 'center-x', 'center-y'])
        .describe(
          'Which edge to share: left/right/top/bottom, or center-x to share a vertical ' +
            'centre line and center-y a horizontal one.',
        ),
    },
  },
  async ({ ids, edge }) => ok(await applyOp({ op: 'align', ids, edge })),
);

server.registerTool(
  'distribute',
  {
    title: 'Distribute nodes',
    description:
      'Space three or more nodes evenly. The outermost two stay where they are and define ' +
      'the span; the rest are placed so the gaps between boxes are equal, accounting for ' +
      'differing widths. Nodes you do not list never move.' +
      TIDY_CAVEAT,
    inputSchema: {
      ids: z.array(z.string()).min(2).describe('Ids of the nodes to space out.'),
      axis: z
        .enum(['horizontal', 'vertical'])
        .describe('Spread them left-to-right (horizontal) or top-to-bottom (vertical).'),
    },
  },
  async ({ ids, axis }) => ok(await applyOp({ op: 'distribute', ids, axis })),
);

/**
 * Diagram management is not an op: it changes nothing inside a diagram, so it carries no
 * rev and never appears in the change feed.
 */
server.registerTool(
  'list_diagrams',
  {
    title: 'List diagrams',
    description:
      'List every diagram in the workspace with its node and edge counts, and say which ' +
      'one is active. The active one is what the human is looking at and what every ' +
      'other tool here reads and writes.',
    inputSchema: {},
  },
  async () => ok(await call('/api/diagrams')),
);

server.registerTool(
  'create_diagram',
  {
    title: 'Create diagram',
    description:
      'Create a new, empty diagram. It does NOT become active — the human keeps looking ' +
      'at whatever they were looking at, so call switch_diagram if you want them to see ' +
      'it. Names become filenames: letters, digits, dot, dash and underscore only.',
    inputSchema: {
      name: z.string().min(1).describe('Name for the new diagram, e.g. "auth-flow".'),
    },
  },
  async ({ name }) =>
    ok(
      await call('/api/diagrams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    ),
);

server.registerTool(
  'switch_diagram',
  {
    title: 'Switch diagram',
    description:
      'Make a diagram the active one. This is not a private read: it changes what is on ' +
      'the human\'s screen, so switch because they asked to see something else, not to ' +
      'go and look at something yourself. Every other tool then operates on this diagram.',
    inputSchema: {
      name: z.string().min(1).describe('Name of an existing diagram; see list_diagrams.'),
    },
  },
  async ({ name }) =>
    ok(
      await call('/api/diagrams/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    ),
);

server.registerTool(
  'create_subdiagram',
  {
    title: 'Create subcanvas',
    description:
      "Give a node its own diagram, holding that node's detail — the sub-plan behind a " +
      'plan step, or the control flow inside one box. It creates the diagram and links ' +
      'the node in one call.\n\n' +
      'The human sees a lens badge on that node and can open it in a panel beside it. ' +
      'This does NOT move their view, and neither does filling it in: follow up with ' +
      'generate_graph passing the returned diagram name, and the detail appears behind ' +
      'the badge without their canvas moving.\n\n' +
      'Deleting the node later leaves this diagram intact rather than destroying it, so ' +
      'an accidental delete cannot throw away the work inside.',
    inputSchema: {
      node_id: z.string().describe('Id of the node to give a subcanvas to.'),
      name: z
        .string()
        .optional()
        .describe('Name for the new diagram. Defaults to "<node id>-detail".'),
      diagram: z
        .string()
        .optional()
        .describe('Diagram the node lives in. Defaults to the active one.'),
    },
  },
  async ({ node_id, name, diagram }) => {
    const subcanvas = name ?? `${node_id}-detail`;
    // Adopting a diagram that already exists is reasonable — linking a node to detail
    // written earlier is a real thing to want — so only a different failure is fatal.
    try {
      await call('/api/diagrams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: subcanvas }),
      });
    } catch (err) {
      if (!/already exists/i.test((err as Error).message)) throw err;
    }
    const linked = await applyOp({ op: 'update_node', id: node_id, subcanvas }, diagram);
    return ok({ subcanvas, ...(linked as Record<string, unknown>) });
  },
);

await server.connect(new StdioServerTransport());
