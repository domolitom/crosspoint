# Crosspoint

<p align="center">
  <img src="assets/logo-512.png" alt="Crosspoint" width="220" />
</p>

A way to talk to an AI agent in pictures.

The name is the point: a crosspoint is where two things meet at a shared coordinate. You and
the agent edit the same graph, so you are always looking at the same thing — instead of the
agent reconstructing an approximation from a screenshot.

The mark is the same idea: one line of dots is you, the other is the agent, and the dot
where they cross is violet — both colours at once, one shared point.

## The problem

Conversation with an agent is text. That works until the thing you are discussing has shape —
a control flow graph, a plan with branches, a system with parts that talk to each other.
Describing that in prose is slow and lossy in both directions.

Showing the agent a picture doesn't fix it:

- it's image recognition, not understanding — small text and dense layouts are easy to misread;
- every round of feedback costs image tokens, proportional to the diagram's complexity;
- the agent can't *edit* the picture back except by regenerating it and hoping the re-render
  matches what you meant.

Text-first diagram tools (Mermaid, Graphviz/DOT) let an agent read and write cheaply and
exactly, but they describe *structure* only. Layout is computed by the renderer, not stored.
So when you drag a box to where it belongs, there is nothing for that drag to write back to.

## The idea

Make the diagram a **graph with position as first-class data** — the same model node-graph UI
libraries already use internally — and put it in a plain file both sides can edit:

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

## Running it

```bash
npm install
npm run build
npm run dev
```

Then open http://localhost:5173. That's the development setup — vite for hot reload, with the
server on :4000.

To let an agent edit the same graph, point it at the MCP server. `.mcp.json` already
configures it for Claude Code; it needs `npm run build` to have run and the server to be up.

## Use it on another project

Diagrams belong to the project they describe, so Crosspoint runs against whatever directory
you are standing in. Build it once:

```bash
cd /path/to/crosspoint
npm install && npm run build
```

Register the MCP server so it's available everywhere, using an absolute path — a relative one
only resolves when your working directory happens to be this repo:

```bash
claude mcp add crosspoint -s user \
  -e CROSSPOINT_SERVER=http://localhost:4000 \
  -- node /path/to/crosspoint/packages/mcp/dist/index.js
```

Then, in any project:

```bash
node /path/to/crosspoint/bin/crosspoint.js
```

That serves the canvas and the API together on http://localhost:4000 — one process, no vite
needed. Diagrams go in `.crosspoint/` in that project, and the folder is created with a
`.gitignore` containing `*`, so it keeps itself out of your repo without anything being added
to your own `.gitignore`. Pass a directory to put them somewhere else:

```bash
node /path/to/crosspoint/bin/crosspoint.js docs/diagrams
```

Two things worth knowing. The MCP server is a thin client of the HTTP API, so **it needs the
Crosspoint server running** — start that first or every tool call fails. And the MCP process is
long-lived: after rebuilding the `mcp` package, **reconnect the client** (`/mcp` in Claude Code)
or you will keep talking to the old tool schema.

## The agent surface

The agent gets structural operations only: `get_graph`, `add_node`, `add_edge`,
`reconnect_edge`, `update_node`, `update_edge`, `delete_node`, `delete_edge`.

**There is deliberately no tool for moving a node.** Coordinates are absent from every write
tool — not discouraged, not approval-gated, architecturally missing from the schema. An agent
cannot express a position, so it cannot overwrite one. New nodes are placed by the server
clear of what already exists; `add_node` takes a `near: <nodeId>` hint rather than a position.

This is a default rather than the project's reason to exist. It earns its place by stopping
the agent rearranging your canvas while you are mid-thought — not because a diagram in a
conversation is a precious artifact.

## What this is not

Position-as-data in a plain file is table stakes: JSON Canvas, Cytoscape's `.cyjs`, `.tldr`,
`.excalidraw` and draw.io's `mxGeometry` all do it. Live agent-to-canvas sync has shipped
elsewhere too — `yctimlin/mcp_excalidraw` has it today.

What appears not to exist anywhere else is the combination: a real typed node/edge graph
whose layout a human authors and keeps, with an agent API that categorically cannot express
geometry. `zindex.ai` makes the closest argument — *"agents describe structure, not pixels"* —
but withholds pixels because a layout **algorithm** owns placement, and there is no canvas to
drag on. That's the auto-layout answer this project exists to avoid.

**JSON Canvas is not a viable format here**, despite the obvious appeal. Its v1.0 spec makes
`x`, `y`, `width` and `height` mandatory on every node, with no extensibility mechanism. A
format that requires geometry on every node cannot be written by an agent that never emits
geometry. It is also note-centric (text/file/link/group) rather than a general labelled graph.

## Status

Working prototype. What runs today:

- graph model with position as first-class data, ops, size-aware placement, stable
  serialisation
- server owning graph state, persisting atomically, syncing live over websocket, and
  picking up external edits to the file
- React Flow canvas: drag, connect, reconnect, select, delete, rename, drag-from-palette to
  create, nodes auto-sized to their labels
- MCP server exposing the eight structural tools above
- tests for the graph model and an end-to-end suite driving a real server process

Designed and agreed, not yet built:

- **append-only op log** behind `get_changes`, with a server-tracked watermark, so the agent
  can read what changed since it last looked
- **`generate_graph`** — one operation creating a whole graph, laid out hierarchically with
  dagre, refusing a non-empty diagram unless `replace: true`
- **named diagrams** — a directory of them, one active, with a switcher in the header
- **subcanvases** — a node references another diagram; a lens badge opens it in a floating,
  editable panel anchored to that node, one at a time, navigating within itself by breadcrumb.
  Deleting the parent node orphans the subcanvas rather than destroying it
- **code references** in node `data` (file, symbol, lines) so the agent knows which function
  a box is
- **semantic layout ops** (`align` and similar) that the server resolves into geometry, so the
  agent can tidy without expressing coordinates
- **a committed Playwright browser suite** as the verification bar

Nothing here has auth. The server binds locally and trusts its callers.
