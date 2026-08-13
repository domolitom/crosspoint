# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

npm workspaces, TypeScript throughout, Node 22+.

```bash
npm install
npm run dev                      # core build + server (:4000) + vite canvas (:5173)
npm run build                    # all four packages
npm test                         # core unit tests + server end-to-end tests

npm run test -w @crosspoint/core     # graph model: ops, placement, serialisation
npm run test -w @crosspoint/server   # spawns a real server, ws client + HTTP agent
node --test packages/core/dist/graph.test.js --test-name-pattern "placement"
```

Tests compile first (`tsc`) and run against `dist/`, so a single test file is
`node --test packages/<pkg>/dist/<name>.test.js`. Note that `node --test <dir>/` silently
passes on zero matches — always use the `dist/*.test.js` glob.

The server takes the graph path as `argv[2]` or `CROSSPOINT_GRAPH`; port via
`CROSSPOINT_PORT`. `.mcp.json` wires the MCP server up for Claude Code — it needs
`npm run build` to have run, and the main server to be up.

## What Crosspoint is

A diagramming tool whose canonical format is a graph with **position as first-class data**, so a
human and an AI agent can edit the *same* representation instead of the agent reconstructing an
approximation from a screenshot.

The canonical form is graph JSON, shaped like React Flow's internal model:

```
{ nodes: [{ id, position, data }], edges: [{ source, target, label }] }
```

## Design constraints to preserve

These are the decisions that motivate the project; changes that violate them defeat its purpose.

- **Position lives in the source of truth, not in the renderer.** This is the explicit reason the
  project does not build on Mermaid or Graphviz/DOT: those describe structure only and let the
  renderer compute layout, so a user's drag-to-reposition has nothing to write back to. Any
  proposal to adopt a text-DSL diagram format needs to answer that.
- **No image round-trip for agents.** Agent access is via reading/writing the graph structure
  directly — either the JSON file, or an MCP server exposing structural operations (`add_node`,
  `add_edge`, `update_node`, `get_graph`) for atomic edits. Screenshot-based understanding is the
  problem being solved, not an acceptable fallback.
- **Bidirectional and live.** Edits from either side (browser canvas, agent) must surface to the
  other without a manual reload — via file-watch or a lightweight live-update channel.

## Architecture

Four workspaces under `packages/`:

- **`core`** — the graph model. Types, `applyOp`, seed placement, diff-stable serialisation.
  Pure and dependency-free; both the server and the canvas import it.
- **`server`** — owns the graph. HTTP + websocket on :4000, atomic file persistence.
- **`web`** — Vite + React + `@xyflow/react` canvas on :5173, proxying `/api` and `/ws`.
- **`mcp`** — stdio MCP server, a thin structural client of the HTTP API.

**The server owns state; the file is persistence, not the live source of truth.** This was chosen
over "everyone writes the file, a watcher fans changes out" specifically to avoid write-echo
loops and half-written reads. The file watcher in `store.ts` exists only to pick up *external*
edits (a human editing the JSON by hand), and distinguishes those from its own writes by
comparing against the last text it wrote.

Two details there are load-bearing and easy to regress:

- Persistence is write-to-temp-then-`rename`, so a watcher never sees a partial file.
- The watcher watches the *directory*, not the file. `rename` swaps the inode, which silently
  kills a file-level watch after the first save. This was a real bug caught by the round-trip
  tests.

### The read/write asymmetry (the core invariant)

Position is data the agent must **preserve**, not data it **consumes**. Pixel coordinates carry
no meaning for reasoning about a diagram and only cost tokens; they are the human's payload.

This is enforced structurally, not by convention:

- `StructuralOp` carries no coordinates; `LayoutOp` (`move_node`) does. See `core/src/types.ts`.
- The MCP server exposes only structural ops — **there is deliberately no `move_node` tool**. An
  agent cannot express a position, so it cannot clobber one.
- `get_graph` returns `structuralView()` (ids, labels, edges — no geometry) unless
  `include_positions` is passed.
- `add_node` takes an optional `near: <nodeId>` hint instead of coordinates. The server places
  the node clear of existing ones.

Placement is a *seed*, not an authority: `placeNode` only ever positions the new node and never
moves existing ones. Running a global layout engine (dagre/elk) would re-solve the whole diagram
and move nodes the human pinned — the exact failure mode stored positions exist to prevent.

Correspondingly, `normalize()` passes hand-written positions through verbatim. Loading a file
must not rewrite the human's coordinates; snapping applies to drags and seeds only.

### Canvas specifics

Dragging updates local React state at 60fps but only persists on `onNodeDragStop` — intermediate
positions are animation, not data. Incoming server state never overwrites a node that is mid-drag
(tracked in a `dragging` ref), which is what stops an agent's structural edit from making the node
you are holding jump.

Edges render through `DirectedEdge.tsx` with an arrowhead, since `source`/`target` were always
directed and the canvas should say what the data says. Where `A→B` and `B→A` both exist, their
labels would stack; the component offsets each label along the normal to its own source→target
axis. Two traps, both found by measuring the rendered DOM rather than by eye:

- `pathOptions.curvature` cannot separate such a pair — React Flow ignores curvature whenever the
  handles already face each other and uses `0.5 * distance` instead.
- The offset is a single positive constant, *not* a per-edge sign. The normal already points the
  opposite way for the reverse edge; negating it as well cancels out and restacks the labels.

There is no optimistic edge on connect: the server assigns the id (`source->target`), so inventing
a local one renders a duplicate that is immediately replaced.
