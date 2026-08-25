# Crosspoint

<p align="center">
  <img src="assets/logo-512.png" alt="Crosspoint" width="220" />
</p>

A way to talk to an AI agent in pictures. You and the agent edit the same graph, so you are
always looking at the same thing — instead of the agent reconstructing an approximation from
a screenshot.

## The problem

Conversation with an agent is text, which works until the thing you are discussing has shape:
a control flow graph, a plan with branches, a system with parts that talk to each other.

Screenshots don't fix it — that's image recognition, it costs image tokens every round, and
the agent can't edit the picture back. Mermaid and Graphviz let an agent read and write
cheaply, but they describe *structure* only: layout is computed by the renderer, never stored,
so when you drag a box to where it belongs there is nothing for that drag to write to.

## The idea

Make the diagram a **graph with position as first-class data**, in a plain file both sides
can edit:

```json
{
  "nodes": [{ "id": "parse", "position": { "x": 300, "y": 135 }, "data": { "label": "Parse input" } }],
  "edges": [{ "id": "read->parse", "source": "read", "target": "parse" }]
}
```

Then the diagram becomes a medium of instruction rather than documentation:

1. You ask for something to be visualised. The agent generates the graph.
2. You edit it — drag, connect, relabel, delete — as much as you like. Nothing happens yet.
3. You say go. The agent reads the accumulated diff and implements it.

**Your edit is the request.** Moving a box, drawing an edge, or deleting a node is how you
say what you want, and the agent reads it exactly rather than guessing from an image.

## Quick start

Needs Node 22+.

```bash
npm install && npm run build
```

Then, in any project you want diagrams for:

```bash
node /path/to/crosspoint/bin/crosspoint.js        # canvas + API on :4000
```

Diagrams land in `.crosspoint/`, which creates its own `.gitignore` so it stays out of your
repo. Pass a directory to put them elsewhere. To let an agent edit the same graph, register
the MCP server once with an absolute path:

```bash
claude mcp add crosspoint -s user \
  -e CROSSPOINT_SERVER=http://localhost:4000 \
  -- node /path/to/crosspoint/packages/mcp/dist/index.js
```

The MCP server is a thin client of the HTTP API, so **the Crosspoint server must be running**
or every tool call fails. After rebuilding `mcp`, reconnect the client (`/mcp` in Claude Code)
or you keep talking to the old tool schema.

### Docker

Images are built and published to `ghcr.io` by CI on every push to `master` and every `v*`
tag.

```bash
docker run --rm -p 4000:4000 -v "$PWD/.crosspoint:/diagrams" ghcr.io/domolitom/crosspoint
```

Or build it yourself with `docker build -t crosspoint .`.

The volume is not optional — diagrams live in `/diagrams`, and without it your work dies with
the container. The image runs as uid 1000, so on Linux a bind mount needs to be writable by
that uid (`chown 1000:1000 .crosspoint`); Docker Desktop handles this for you.

The image serves the canvas and API only. The MCP server is stdio and has to run beside your
agent, so register it on the host as above and point it at `http://localhost:4000`.

### Development

```bash
npm run dev     # vite on :5173 with hot reload, server on :4000
npm test        # core + server + a real browser
```

## The agent surface

The agent gets sixteen tools, and not one of them can express a coordinate.

- **read** — `get_graph`, `get_changes`, `list_diagrams`
- **structure** — `add_node`, `add_edge`, `reconnect_edge`, `update_node`, `update_edge`,
  `delete_node`, `delete_edge`, `generate_graph`
- **diagrams** — `create_diagram`, `switch_diagram`, `create_subdiagram`
- **tidying** — `align`, `distribute`, which name an intent the server resolves into geometry

**There is deliberately no tool for moving a node.** Coordinates are absent from every write
tool — not discouraged, not approval-gated, architecturally missing from the schema. An agent
cannot express a position, so it cannot overwrite one. New nodes are placed by the server
clear of what already exists; `add_node` takes a `near: <nodeId>` hint rather than a position.

It earns its place by stopping the agent rearranging your canvas while you are mid-thought.

## Prior art

Position-as-data in a plain file is table stakes — JSON Canvas, Cytoscape's `.cyjs`, `.tldr`
and draw.io all do it, and live agent-to-canvas sync has shipped elsewhere too. What seems
not to exist is the combination: a typed node/edge graph whose layout a human authors and
keeps, with an agent API that categorically cannot express geometry.

JSON Canvas was the obvious format to adopt and doesn't work here — its v1.0 spec makes `x`,
`y`, `width` and `height` mandatory on every node, and a format that requires geometry cannot
be written by an agent that never emits it.

## Status

Working prototype, developed using itself — the plans in this repo were drawn in it. Running
today: the graph model and ops, a server owning state and syncing live over websocket, the
React Flow canvas (drag, connect, reconnect, resize, rename, colour, undo/redo), named
diagrams with a switcher, subcanvases in a floating editable panel, `generate_graph` via
dagre, an op log behind `get_changes`, semantic layout ops, and the sixteen MCP tools — with
tests for core and server plus a Playwright suite driving a real browser.

Not yet built: **code references** in node `data` (file, symbol, lines), and **batched edits**
so the agent never acts on a change the moment it lands.

Nothing here has auth. The server binds locally and trusts its callers.

MIT licensed. Contributing guidance for agents is in [AGENTS.md](AGENTS.md); the invariants
and the traps behind them are in [CLAUDE.md](CLAUDE.md).
