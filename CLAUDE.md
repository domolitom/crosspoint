# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

npm workspaces, TypeScript throughout, Node 22+.

```bash
npm install
npm run dev                      # core build + server (:4000) + vite canvas (:5173)
npm run build                    # all four packages
npm test                         # core + server + the browser suite

npm run test -w @crosspoint/core     # graph model: ops, placement, arrange, serialisation
npm run test -w @crosspoint/server   # spawns a real server, ws client + HTTP agent
npm run test -w @crosspoint/e2e      # real browser against a real stack (~13s)
node --test packages/core/dist/graph.test.js --test-name-pattern "placement"
```

Tests compile first (`tsc`) and run against `dist/`, so a single test file is
`node --test packages/<pkg>/dist/<name>.test.js`.

The server takes a **diagrams directory** as `argv[2]` or `CROSSPOINT_DIAGRAMS`; port via
`CROSSPOINT_PORT`. Passing a `.json` file instead still works and means "one diagram, named
after the file" — that is how `npm run dev` keeps an existing `graph.json` live. `.mcp.json` wires the MCP server up for Claude Code — it needs
`npm run build` to have run, and the main server to be up.

`graph.json`, `diagrams/`, `*.ops.jsonl` and `*.state.json` are gitignored on purpose. They
are live documents the server rewrites on every edit; tracking them turns ordinary use into a
dirty working tree. Never `git add` them, and never `git add -A` in this repo.

## What Crosspoint is

**A visual channel in the conversation, not a diagramming tool.** The user asks for something
to be visualised, the agent renders it as a graph, the user edits the graph, and *the edit is
the request* — the agent reads the diff and implements it in code. The picture is how the user
talks to the agent, not an artifact they are curating.

This framing matters when weighing changes. Optimise for the round trip being fast and
unambiguous, not for the diagram being beautiful or permanent.

## Architecture

Five workspaces under `packages/`:

- **`core`** — the graph model. Types, `applyOp`, placement, `arrange`, dagre generation,
  diff-stable serialisation. `@dagrejs/dagre` is its one runtime dependency, isolated in
  `generate.ts`; both the server and the canvas import this package.
- **`server`** — owns every diagram. `Workspace` holds the directory and the shared op log,
  `DiagramFile` holds one graph. HTTP + websocket on :4000, atomic file persistence.
- **`web`** — Vite + React + `@xyflow/react` canvas on :5173, proxying `/api` and `/ws`.
- **`mcp`** — stdio MCP server, a thin structural client of the HTTP API.
- **`e2e`** — Playwright against a real stack on its own ports. The layer where every silent
  bug in this project has lived.

**The server owns state; files are persistence, not the live source of truth.** This was
chosen over "everyone writes the file, a watcher fans changes out" specifically to avoid
write-echo loops and half-written reads. The watcher in `workspace.ts` exists only to pick up
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
useful agent capability; the escape hatch is semantic intent ops — `align` and `distribute`,
now built — that the server resolves into geometry, never raw pixels.

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

The exception, now built as `generate_graph`: dagre lays out an **agent-generated** graph,
because seeding a brand-new 40-node graph is a different act from re-solving one the human
has arranged. Stored positions still win permanently once set, and nothing re-runs dagre over
an existing arrangement.

### Loading a file must not rewrite the human's coordinates

`normalize()` passes hand-written positions through verbatim. Snapping applies to drags and
seeds only. An earlier version snapped on load, which silently moved `x: 400` to `405` just
from opening the file.

### The server is the only authority on what exists

No optimistic updates in the canvas. `onConnect` and `onReconnect` send the op and wait for
the push, because the server assigns the id — a locally invented one renders a duplicate that
is immediately replaced.

### `isLayoutOp` and `kindOf` answer different questions

Do not collapse these back into one predicate. They overlap enough to look redundant and
they are not:

- **`isLayoutOp`** gates the **write surface**: does this op carry a raw coordinate, and
  must it therefore stay off MCP?
- **`kindOf`** gates **change-feed noise**: is this entry part of the human's message, or
  did it only change where things sit?

The two disagree in both directions, which is the point:

| op | `isLayoutOp` | `kindOf` | why |
| --- | --- | --- | --- |
| `align`, `distribute` | `false` | `layout` | names no coordinate, so an agent may issue it — but only moves boxes, so it is noise |
| `add_node_at` | `true` | `structural` | names a coordinate, so agents cannot issue it — but creates a node, which is always the message |
| `move_node` | `true` | `layout` | both |
| `generate_graph` | `false` | `structural` | server computes the geometry, and creating a diagram *is* the message |

`kindOf` used to be derived from `isLayoutOp`, and that produced a real bug: a node dragged
from the palette was tagged `layout` and filtered out of the feed as noise, so an agent
never saw the box the user had just added. The test asserting that behaviour encoded the
bug. `kindOf` now has its own list, and the question it asks is only ever *did this change
what exists, or just where it sits*.

### `rev` counts the workspace, not the diagram

One monotonic counter spans every diagram. That is not incidental: `get_changes` is a flat
chronological feed across diagrams, and two diagrams that both reached "rev 5" give it no
total order to sort by. There is likewise **one** op log and **one** watermark for the
workspace — independently-numbered logs cannot be merged into a total order either.

The consequence that reads like a bug and is not: a diagram file's stored `rev` means *the
workspace rev at which this file was last written*, so it legitimately trails the counter
when the most recent ops went to a different diagram. `/api/graph` reports that per-diagram
rev, because it is what a stale-write check must compare against. `/api/changes` reports the
workspace rev, because `since` is measured against the same counter. Reporting the diagram's
rev there was a real inconsistency, caught by the interleaving test.

## Traps, each paid for with a real bug

**File watching must watch the directory, not the file.** Atomic saves replace the file by
rename, which swaps the inode; a file-level watch is bound to the old one and goes silent
after the first write, including the server's own.

**In single-file mode the workspace directory must not be scanned.** Pointing the server at
`graph.json` puts the workspace in the repo root, where a `*.json` scan happily adopts
`package.json` and `tsconfig.json` as diagrams. Sidecars are a hazard even in a real diagram
directory, since `*.state.json` is also `.json`. File mode takes its diagram list from state
instead of the filesystem.

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

## Built since the reframing

Check the code, not this list, for what exists — but these are done and covered by tests:
the op log behind `get_changes`, `generate_graph` with dagre, named diagrams with a switcher,
node colour, semantic layout ops (`align`, `distribute`), and the Playwright suite in `npm test`.

## Designed and agreed, not yet built

Check the code before trusting this list; it records decisions, not status.

- **Batched edits** — the user edits freely and nothing happens until they say go; the agent
  then reads the accumulated diff. Never act on a change the moment it lands.
- **Subcanvases** — a node references another diagram by name in its `data`. A lens badge
  opens it in a floating, *editable* panel anchored to that node. One panel at a time;
  lensing deeper replaces its contents with an in-panel breadcrumb. Deleting the parent node
  **orphans** the subcanvas rather than destroying it. A panel must refuse to open the diagram
  that is already the active main canvas — that is circular.
- **Code references** in node `data` (`file`, `symbol`, `lines`).

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
