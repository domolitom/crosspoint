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
`node --test packages/<pkg>/dist/<name>.test.js`.

The server takes the graph path as `argv[2]` or `CROSSPOINT_GRAPH`; port via
`CROSSPOINT_PORT`. `.mcp.json` wires the MCP server up for Claude Code — it needs
`npm run build` to have run, and the main server to be up.

`graph.json` is gitignored on purpose. It is a live document the server rewrites on every
edit; tracking it turns ordinary use into a dirty working tree. Never `git add` it, and never
`git add -A` in this repo.

## What Crosspoint is

**A visual channel in the conversation, not a diagramming tool.** The user asks for something
to be visualised, the agent renders it as a graph, the user edits the graph, and *the edit is
the request* — the agent reads the diff and implements it in code. The picture is how the user
talks to the agent, not an artifact they are curating.

This framing matters when weighing changes. Optimise for the round trip being fast and
unambiguous, not for the diagram being beautiful or permanent.

## Architecture

Four workspaces under `packages/`:

- **`core`** — the graph model. Types, `applyOp`, placement, diff-stable serialisation. Pure
  and dependency-free; both the server and the canvas import it.
- **`server`** — owns the graph. HTTP + websocket on :4000, atomic file persistence.
- **`web`** — Vite + React + `@xyflow/react` canvas on :5173, proxying `/api` and `/ws`.
- **`mcp`** — stdio MCP server, a thin structural client of the HTTP API.

**The server owns state; the file is persistence, not the live source of truth.** This was
chosen over "everyone writes the file, a watcher fans changes out" specifically to avoid
write-echo loops and half-written reads. The watcher in `store.ts` exists only to pick up
*external* edits, and tells them from its own writes by comparing against the last text it
wrote.

## Invariants — the things that are easy to regress

### Coordinates never reach the agent's write surface

`StructuralOp` carries no coordinates; `LayoutOp` (`move_node`, `add_node_at`) does. Only
structural ops are exposed over MCP, so **there is deliberately no `move_node` tool**. The
agent cannot express a position, so it cannot overwrite one.

When adding any agent-facing capability, check it against this. A `position` field on
`add_node` would silently destroy the invariant — which is why drag-to-create went in as a
separate `add_node_at` *layout* op rather than a field on the existing structural one.

Note this is now framed as a sensible default rather than the project's reason to exist. It
stops the agent thrashing the user's arrangement mid-thought. Do not let it block genuinely
useful agent capability; the escape hatch is semantic intent ops (`align`) that the server
resolves into geometry, never raw pixels.

### Colour is the exception, and it is deliberate

Node colour reaches the agent's *write* surface — `add_node` and `update_node` both take it.
That is not a leak. The invariant protects the human's **layout**, and recolouring destroys
no spatial work, so the reasoning that bars coordinates does not apply. It is on the surface
because a coloured node is usually a statement — amber for "needs attention", red for
"broken" — and a channel where only one side can make that statement is worse.

Two rules keep it honest. It is stored **by name**, never as hex, because the point of a
stored value is that a reader can rely on it and `#a3221c` says nothing. And it is a
validated field rather than a free entry in the open `data` bag, so an invented name is
refused at the door. `"none"` deletes the key instead of storing a sentinel.

Colour is tagged `structural`, so it survives `withoutLayout`. Filtering it as noise would
throw away the message.

### Placement seeds, it does not re-solve

`placeNode` only ever positions the *new* node and never moves existing ones. Running a global
layout engine over the whole graph would move nodes the human has pinned — the exact failure
mode stored positions exist to prevent.

The agreed exception, when it lands: dagre may lay out an **agent-generated** graph, because
seeding a brand-new 40-node graph is a different act from re-solving one the human has
arranged. Stored positions still win permanently once set.

### Loading a file must not rewrite the human's coordinates

`normalize()` passes hand-written positions through verbatim. Snapping applies to drags and
seeds only. An earlier version snapped on load, which silently moved `x: 400` to `405` just
from opening the file.

### The server is the only authority on what exists

No optimistic updates in the canvas. `onConnect` and `onReconnect` send the op and wait for
the push, because the server assigns the id — a locally invented one renders a duplicate that
is immediately replaced.

## Traps, each paid for with a real bug

**File watching must watch the directory, not the file.** Atomic saves replace the file by
rename, which swaps the inode; a file-level watch is bound to the old one and goes silent
after the first write, including the server's own.

**`node --test <dir>/` reports success on zero matches.** It silently passed a suite that
found no test files at all. Always use the `dist/*.test.js` glob.

**The canvas node rebuild must spread the whole `data` bag.** It once picked out `label`
alone, so any other key — colour, and code references later — was silently dropped on the
next server push. The value reached the browser and then vanished on the following frame.

**`.bar button` beats a bare `.swatch` on specificity** — (0,1,1) against (0,1,0). Every
colour swatch rendered as an identical grey pill while every colour *assertion* still
passed, because the assertions measured the nodes rather than the buttons. Found by looking
at a screenshot. Toolbar rules need scoping under `.bar`.

**React Flow's controlled mode delivers selection through `onNodesChange`/`onEdgesChange`.**
Without `onEdgesChange`, clicking an edge never marks it selected, so Delete has nothing to
act on and `onEdgesDelete` never fires. Edges were silently unselectable for exactly this
reason, while nodes worked only because `onNodesChange` had been added for dragging.

**`deleteKeyCode` defaults to Backspace alone**, so the Delete key was inert.

**`OnNodeDrag` is `(event, node, nodes)` — the third argument is every dragged node.**
Consuming only the second means a multi-node drag persists just the node under the cursor and
the rest silently revert on the next server push.

**`pathOptions.curvature` cannot separate a reciprocal edge pair.** React Flow ignores
curvature whenever the handles already face each other and uses `0.5 * distance` instead.
Reciprocal labels are separated by offsetting each along the normal to its own source→target
axis, in `DirectedEdge.tsx`. That offset is one positive constant, **not** a per-edge sign:
the normal already reverses for the opposite edge, so negating it too cancels out.

**Placement must use real node sizes.** Nodes size themselves to their label in the browser,
but placement runs on the server with no DOM, so it estimates. A shared width constant made
wide nodes overlap by 110px. The regression guard is the mixed short/long-label overlap test —
a test using only short labels will not catch it.

**Workspace scripts run with the package as cwd.** `npm run dev -w @crosspoint/server` created
its graph in `packages/server/` until the root script started passing an absolute path.

**Never write non-UTF8 bytes into source.** Two literal NUL bytes used as a separator in a
template literal worked fine at runtime but made git classify the file as *binary* — diffs
became `Bin 6794 -> 7788 bytes` and grep skipped the file entirely.

**The canvas has no error surface.** A dropped interaction just does nothing. Three separate
defects were invisible for exactly this reason. Verify canvas changes by driving a real
browser and asserting against the HTTP API — not by reasoning about the code.

## Designed and agreed, not yet all built

Check the code before trusting this list; it records decisions, not status.

- **Op log + `get_changes`** — append-only, server-tracked watermark so the agent knows where
  it left off across a context wipe. Returns a flat chronological list across all diagrams,
  each entry tagged with its diagram and whether it is structural or layout.
- **Batched edits** — the user edits freely and nothing happens until they say go; the agent
  then reads the accumulated diff. Never act on a change the moment it lands.
- **`generate_graph`** — one op building a whole graph, laid out with dagre. Refuses a
  non-empty diagram unless `replace: true`, so a sub-plan cannot vanish by accident.
- **Named diagrams** — a directory, one active, with a visible switcher in the header.
- **Subcanvases** — a node references another diagram by name in its `data`. A lens badge
  opens it in a floating, *editable* panel anchored to that node. One panel at a time;
  lensing deeper replaces its contents with an in-panel breadcrumb. Deleting the parent node
  **orphans** the subcanvas rather than destroying it. A panel must refuse to open the diagram
  that is already the active main canvas — that is circular.
- **Code references** in node `data` (`file`, `symbol`, `lines`).
- **Semantic layout ops** (`align`) the server resolves into geometry.
- **A committed Playwright browser suite** run by `npm test`.

## Parked decisions

Agreed in principle, deliberately not acted on yet:

- reverting `get_graph` to structure-only, so coordinates vanish from the agent's *reads* as
  well as its writes
- splitting `core` into `structure/` and `layout/` so layout code stops sitting in the middle
  of the graph model

## Known gaps

Neither loses data; both were found by audit rather than by failure.

- A sub-grid nudge sends a no-op `move_node` — the position the node already had, because
  snapping absorbs it. The server applies unconditionally, bumping rev and rewriting the file.
- Deleting a node sends `delete_edge` then `delete_node`, but the server's cascade would have
  removed that edge anyway. It works only because the ordering happens to favour it; flipped,
  those ops would 400.
