# Crosspoint

<p align="center">
  <img src="assets/logo-512.png" alt="Crosspoint" width="220" />
</p>

https://github.com/user-attachments/assets/2c560147-7b1d-4586-80ca-d080e82f16ba

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

## Subcanvases

A node can have a whole diagram behind it. The lens badge opens that diagram in a floating
panel which is the *same* editable canvas, not a preview — so detail sits with the step it
belongs to instead of crowding the picture it explains. The panel drags by its header, and
deleting a linked node orphans its subcanvas rather than destroying it.

<p align="center">
  <img src="assets/subcanvas.png" alt="A release pipeline whose CI node opens its own diagram in the lens panel" width="900" />
</p>

## Quick start

Needs Node 22+. In any project you want diagrams for:

```bash
npx crosspoint                                    # canvas + API on :4000
```

Diagrams land in `.crosspoint/`. When Crosspoint creates that folder it writes a `.gitignore`
containing `*`, so it stays out of your repo without touching a file it doesn't own — a
folder that already existed is left alone, and is yours to ignore. Pass a directory to put
diagrams elsewhere. To let an agent edit the same graph, register the MCP server once:

```bash
claude mcp add crosspoint -s user -- npx -y @crosspoint/mcp
```

The MCP server is a thin client of the HTTP API. If nothing is listening when the agent makes
its first call, it starts the server itself, in the directory the agent is working in — so
`npx crosspoint` is how *you* open the canvas, not a step the agent depends on. The server it
starts outlives the agent, so restarting the agent does not close your canvas.

It defaults to `http://localhost:4000`; set `CROSSPOINT_SERVER` if you moved it, and
`CROSSPOINT_NO_SPAWN=1` if you would rather manage the process yourself and be told when it
is missing. A remote server is never started locally, and a port already answering with
something that is not Crosspoint is reported rather than adopted.

### Docker

Docker needs no Node, no toolchain and no `npm install` — from a clone, one command:

```bash
docker compose up
```

Then open http://localhost:4000. It builds locally the first time, so it works on any
architecture and before you can reach the published image. If 4000 is taken, use
`CROSSPOINT_PORT=4001 docker compose up`.

Or pull the published image, which CI builds for **amd64 and arm64** on every push to
`master` (`:latest`, `:master`) and every `v*` tag (`:v0.1.0`, `:v0.1`) — the image tag reads
the same as the release:

```bash
mkdir -p .crosspoint                    # must exist before it is mounted
sudo chown 1000:1000 .crosspoint        # Linux only; the image runs as uid 1000

docker run --rm -p 4000:4000 \
  -v "$PWD/.crosspoint:/diagrams" \
  ghcr.io/domolitom/crosspoint
```

The volume is not optional — diagrams live in `/diagrams`, and without it your work dies with
the container. Because you create that folder rather than Crosspoint, it will not self-ignore:
add `.crosspoint/` to your own `.gitignore`. Skipping the `chown` on Linux leaves the folder
owned by your uid and the server exits on its first write; Docker Desktop maps ownership for
you, which is why this is easy to miss locally and fails in CI.

The image serves the canvas and API only. The MCP server is stdio and has to run beside your
agent, so register it on the host as above and point it at `http://localhost:4000`.

### Development

From a clone:

```bash
npm install && npm run build
npm run dev     # vite on :5173 with hot reload, server on :4000
npm test        # core + server + a real browser
```

To point an agent at the checkout rather than the published package, register the built entry
directly — `-- node /path/to/crosspoint/packages/mcp/dist/index.js`. After rebuilding `mcp`,
reconnect the client (`/mcp` in Claude Code) or you keep talking to the old tool schema.

## The agent surface

The agent gets sixteen tools, and not one of them can express a coordinate.

- **read** — `get_graph`, `get_changes`, `list_diagrams`
- **structure** — `add_node`, `add_edge`, `reconnect_edge`, `update_node`, `update_edge`,
  `delete_node`, `delete_edge`, `generate_graph`
- **diagrams** — `create_diagram`, `switch_diagram`, `create_subdiagram`
- **tidying** — `align`, `distribute`, which name an intent the server resolves into geometry

A node carries a one-line `label` and optional multi-line `body` — the name and the detail.
They are separate fields because ids are derived from labels, and because a long body in the
change feed would bury everything else in it. A pipe table in a body renders as a table.

A node can also carry a `code` reference — `file`, and optionally `symbol` and `lines` — so
the diagram is a map of the codebase and "delete this node" reads as "remove that module".
It renders as one line under the node, in the shape an editor's go-to-line already reads.

Colour and arrowheads are the two presentational things on that surface, and both are there
because they are statements: amber says "needs attention", and `arrow: both` says two things
depend on each other rather than one calling the other. Each is a validated name, refused at
the door if invented, and its default is stored as absence rather than a sentinel.

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

Not yet built: **batched edits**, so the agent never acts on a change the moment it lands.

Nothing here has auth. The server binds locally and trusts its callers.

MIT licensed. Contributing guidance for agents is in [AGENTS.md](AGENTS.md); the invariants
and the traps behind them are in [CLAUDE.md](CLAUDE.md).
