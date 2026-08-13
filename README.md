# Crosspoint

A tool for drawing diagrams *with* an AI agent, not just showing one a picture of what you drew.

The name is the point: a crosspoint is where two things meet at a shared coordinate. That's
the goal here — a diagram representation precise enough that a human and an AI agent can both
edit it directly and always be looking at the same thing, instead of the AI reconstructing an
approximation from a screenshot.

## The problem

Today, getting an AI agent to understand a diagram means showing it a picture. That works, but:

- it's image recognition, not understanding — small text, dense layouts, and subtle visual
  distinctions are genuinely easy to misread;
- every round of feedback costs image tokens, proportional to the diagram's complexity;
- there's no way for the agent to *edit* the diagram back except by regenerating it from
  scratch in text and hoping the re-render matches what you meant.

Text-first diagram tools (Mermaid, Graphviz/DOT) solve the "agent can read/write this cheaply
and exactly" problem, but they're one-directional by design: the syntax describes *structure*
(nodes, edges, labels), not *position*. Layout is computed by the renderer, not stored in the
text. So there's nothing for a user's drag-to-reposition to write back to.

## The idea

Make the diagram's canonical form a **graph with position as first-class data** —
`{ nodes: [{ id, position, data }], edges: [{ source, target, label }] }` — the same model
node-graph UI libraries like React Flow already use internally. Then:

- a human edits it by dragging, connecting, and labeling in a normal visual canvas;
- an agent edits it by reading/writing the same structure directly — no image, no recognition,
  just exact values;
- both sides are looking at the same source of truth, live.

## Sketch of the architecture

- **Source of truth**: the graph JSON (nodes with `position`, edges, arbitrary `data` per node).
- **Visual layer**: a node-graph canvas (React Flow or similar) rendering that JSON, editable
  by dragging/connecting/labeling in the browser.
- **Agent access**: either the JSON file directly (an agent can read/edit it like any other
  file), or a small local MCP server exposing structural operations (`add_node`, `add_edge`,
  `update_node`, `get_graph`) for more precise, atomic edits.
- **Sync**: the canvas subscribes to changes (file-watch or a lightweight live-update channel)
  so an edit from either side shows up for the other without a manual reload.

## Running it

```bash
npm install
npm run build
npm run dev
```

Then open http://localhost:5173. The canvas reads and writes `graph.json` in the repo root
via the server on :4000.

To let an agent edit the same graph, point it at the MCP server — `.mcp.json` in this repo
already configures it for Claude Code, and needs `npm run build` plus a running server.
The tools are `get_graph`, `add_node`, `add_edge`, `update_node`, `update_edge`,
`delete_node`, `delete_edge`.

There is deliberately no tool for moving a node. Coordinates are the human's payload —
meaningless to an agent as input, precious as stored data — so the agent API cannot express
one, and therefore cannot overwrite one. New nodes are placed by the server clear of what
already exists; `add_node` takes a `near: <nodeId>` hint rather than a position.

## Status

Working prototype. Graph model, state-owning server with live sync, React Flow canvas, and
MCP server are all in place and covered by tests (`npm test`) — including an end-to-end test
that drives a real server with a websocket client and agent-style HTTP calls.

Not yet done: multi-diagram support, undo, node types beyond the default box, and auth of
any kind (the server binds locally and trusts its callers).
