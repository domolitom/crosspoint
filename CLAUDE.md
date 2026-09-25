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
npm run test -w @crosspoint/e2e      # real browser against a real stack (~22s)
node --test packages/e2e/dist/lens.test.js   # one e2e slice (~4s)
node --test packages/core/dist/graph.test.js --test-name-pattern "placement"
```

Tests compile first (`tsc`) and run against `dist/`, so a single test file is
`node --test packages/<pkg>/dist/<name>.test.js`.

The server takes a **diagrams directory** as `argv[2]` or `CROSSPOINT_DIAGRAMS`; port via
`CROSSPOINT_PORT`. Passing a `.json` file instead still works and means "one diagram, named
after the file" — that is how `npm run dev` keeps an existing `graph.json` live. `.mcp.json` wires the MCP server up for Claude Code — it needs
`npm run build` to have run. The main server no longer has to be up: a tool call that finds
nothing listening starts one (`packages/mcp/src/autostart.ts`).

### Publishing

Three packages go to npm: `@crosspoint/core`, `@crosspoint/mcp`, and `crosspoint` — the root,
which ships `bin/` plus the built server and canvas. `server`, `web` and `e2e` stay private and
travel inside the CLI package. `.github/workflows/publish.yml` does it on a `v*` tag, in that
order, because the CLI depends on core and a user installing a minute later has to be able to
resolve it. The three versions must match the tag; CI checks. Never publish by hand.

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
  bug in this project has lived. Six suites by concern — `canvas`, `colour`, `lens`,
  `editing`, `resize`, `undo` — each booting its own stack, so they share ports and must
  stay serial (`--test-concurrency=1`). Shared fixtures are in `harness.ts`.

**The server owns state; files are persistence, not the live source of truth.** This was
chosen over "everyone writes the file, a watcher fans changes out" specifically to avoid
write-echo loops and half-written reads. The watcher in `workspace.ts` exists only to pick up
*external* edits, and tells them from its own writes by comparing against the last text it
wrote.

## Invariants — the things that are easy to regress

### Coordinates never reach the agent's write surface

`StructuralOp` carries no coordinates; `LayoutOp` (`move_node`, `add_node_at`, `resize_node`)
does. Only
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

`arrow` on an edge — `forward` (default), `both`, `none` — is on the surface for the same
reason and follows the same three rules: validated at the door, stored by name, and its
default stored as absence rather than a sentinel. It says something colour cannot. `both` is
one edge meaning mutual dependency rather than two opposing edges, and `none` is a plain
association, which the model had no way to express before.

### A node's name and its text are different fields

`label` is one line and `body` is many, and the split is not cosmetic. **Ids are slugified
from the label**, so a label carrying line breaks produces an id nobody can refer to. The
change feed is the second reason: `describeOp` names a body change and its line count but
never quotes it, because a twenty-line body inlined into one entry buries every other entry
in the feed.

`body` is structural — what a node says is the message — so it reaches the agent's read and
write surface, like colour. An empty string clears the key rather than storing `""`.

A pipe table in a body renders in monospace, switched on by content in `CanvasNode`. That is
deliberately a *rendering* decision: columns only line up in monospace and prose only reads
in proportional, and doing it by content keeps tables working with nothing new in the model
and nothing new on the agent's surface.

### A code reference is a validated object, not a loose key

`data.code` is `{ file, symbol?, lines? }`, checked at the door like colour: unknown keys,
an empty `file` or `lines` that is not `"12"` or `"12-40"` are refused, and `"none"` deletes
the key. It is structural and on the agent's write surface for the same reason colour is —
pointing a box at a module says what the box *is* and moves nothing. The feed prints it in
go-to-line shape via `describeCode`, and `nodeText` counts it as one more line so placement
measures the same box the canvas draws.

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
| `add_edge_at` | `true` | `structural` | same shape: names the points, so canvas-only — but creating an edge is the message |
| `attach_edge` | `true` | `layout` | canvas-only, and only moves which point a line touches |
| `move_node`, `resize_node` | `true` | `layout` | both |
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

**A diagram nobody has edited leaves no trace but its file, so creation is logged.** Creating
a diagram is still not a `GraphOp` — nothing inside any diagram changes — but it takes a
workspace rev and goes into the log, because the log is the only durable list file mode has
and `POST /api/diagrams` refuses a name whose file already exists. Without the entry, a
created-but-unedited diagram is unreachable the moment state forgets it: that is how a real
subcanvas target disappeared from the switcher while the node still linked to it. Switching
is deliberately *not* logged — it changes nothing and would bury the feed.

The entry carries **no actor**, and that is the honest answer rather than a gap: the canvas
and the MCP server both create over HTTP, so the transport cannot tell a human in the
switcher from an agent, and an unattributed entry is kept by every filter. Claiming `agent`
would hide every diagram a person made from the human-only default. `recordUnattributed` is
separate from `record` so the latter keeps its required `actor` — the guard that makes a new
transport a compile error instead of a silent misattribution.

**The state sidecar was the one file written without a rename, and a kill bricked the
workspace.** `persistState` used a plain `writeFile`, which truncates first, so a process
killed in that window left `graph.state.json` at zero bytes — and `OpLog.open` then died in
`JSON.parse` on every subsequent start, guarded only for `ENOENT`. One force-kill therefore
made a directory full of diagrams unopenable. Three things now hold: the state write goes
through write-then-rename like a diagram, an unparseable state file is treated as absent
because everything in it is recoverable and refusing to boot costs the human far more than a
watermark, and **file mode takes its diagram list from state and the op log together**. That
last one matters because in file mode the sidecar is otherwise the only list there is, so
losing it showed one diagram beside a directory holding sixteen — and `POST /api/diagrams`
cannot rescue them, because a file on disk counts as existing and is refused. The union
`stat`s each name the log mentions rather than scanning — a scan is what would adopt
`package.json` — and skips a name with no file, which makes deleting the file the way to
retire a diagram.

Gating that union on `known` being *empty* was the first shape of the fix and was not enough:
one boot on the truncated file wrote `known: ['graph']`, after which the condition could
never hold again and the other fifteen were stranded for good. A recovery path that only
runs while the damage is pristine is no recovery path. The inode test is the guard for the
rename: a plain write keeps the inode, so the inode changing is the proof.

**A test that leaks a server process hangs the suite instead of failing it.** A live child
handle keeps `node --test` alive, so a test that starts its own server and asserts before
stopping it turns one failed assertion into a run that never ends — which is what a CI
timeout with no output looks like. It cost two 300s timeouts here before the cause was clear.
Register the teardown with `t.after(stopServer)` so it runs on the failing path too.

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
A reciprocal pair is separated by bowing each curve along the normal to its own source→target
axis, in `DirectedEdge.tsx`. That bow is one positive constant, **not** a per-edge sign:
the normal already reverses for the opposite edge, so negating it too cancels out.

**Placement must use real node sizes.** Nodes size themselves to their label in the browser,
but placement runs on the server with no DOM, so it estimates. A shared width constant made
wide nodes overlap by 110px. The regression guard is the mixed short/long-label overlap test —
a test using only short labels will not catch it.

**An estimate must measure the longest line, not the total length.** `estimateNodeWidth`
summed every character, which is right for one line and badly wrong for many — a body of ten
short lines asked for a box wide enough to hold all of them end to end. It splits on `\n`
now, takes the widest line for width, and counts wrapped lines per line for height. The
server has no DOM, so this estimate is all placement has.

**Everything measuring a node must go through `nodeSize`.** A hand-resized node carries a
`size` and is *wider than its label estimate*, so any code still estimating reasons about a
smaller box than the one on screen — the 110px overlap above, returning by a second route.
`placeNode` and `arrange.ts` both route through it. The guard mixes pinned and auto-sized
nodes; note the test helper `findOverlap` must measure via `nodeSize` too, or it will compare
a 900px box against its 120px estimate and assert nothing.

**`display: flex` with no direction is a row, and that put a node's name beside its body.**
`cp-sized` made a pinned node a flex container so a resized box could centre its label —
harmless while a node was only a label, and wrong the moment it had two children. The text
was all present and correct, just in the wrong place, so no content assertion could see it:
the guard in `resize.test.ts` compares the label's bottom against the body's top.

The same rule has to be `flex-direction: column` *and* stretch the body, or the body shrinks
to its text and its rule stops spanning the box. And a `:has(.cp-node-body)` cap appended
later in the file beats `.cp-sized` at equal specificity, silently re-capping a hand-resized
node — scope it with `:not(.cp-sized)`.

**A pinned size is a floor, not a cage.** The width is the human's call and text wraps
inside it, but a node whose text outgrows its box grows the box — clipping what someone just
typed is never the right answer. The canvas passes the pinned height as `min-height`, and
`nodeSize` returns `max(pinned, estimate at the pinned width)` so the *server* agrees. If it
did not, placement would measure the pinned height while the browser rendered something
taller, and the next node would land on the overflow — the same overlap bug that size-aware
placement exists to prevent, arriving by a third route.

**`scrollHeight > clientHeight` does not mean "clipped" on an `overflow: visible` box.** Text
that does not fit spills out in plain sight rather than scrolling, and the two numbers differ
by padding regardless — it reported a 3px overflow on a node that fit perfectly. Compare the
child's `offsetTop + offsetHeight` against the parent's `clientHeight` instead.

**A pinned node size needs the CSS clamp released, not just an inline width.**
`.react-flow__node-default` sets `max-width: 320px` to stop *auto* sizing running away on a
long label. That cap still applies to an inline width, so a node pinned to 900px rendered at
320 and every attempt to drag it wider looked like it snapped back. `cp-sized` sets
`max-width: none; min-width: 0`. This passed all four resize tests until one pinned a width
*beyond* 320 — under the cap nothing notices, so the regression test must exceed it.

**React Flow's resize handles scale with the canvas.** At low zoom they are sub-pixel and
ungrabbable, so a resize drag silently does nothing. `freshDiagram` in the e2e suite exists
for this: it isolates a test in its own diagram so `fitView` does not zoom out. A probe that
skipped it measured a node at 60x20 and reported resizing as broken when it was not.

**Dragging a top or left resize handle also moves the origin.** Size and position are separate
facts here, so `commitResize` emits `move_node` alongside `resize_node` only when the origin
actually changed — a bottom-right drag stays one op.

**Workspace scripts run with the package as cwd.** `npm run dev -w @crosspoint/server` created
its graph in `packages/server/` until the root script started passing an absolute path.

**Every edge has its points; nothing is computed at render time.** `sourceSide`/`targetSide`
on an edge are layout, and they are **seeded like a position, not derived like a style**:
`sideTowards` runs once — in `add_edge`, in `generate_graph`, on the moved end of a
`reconnect_edge`, and in `normalize` for any edge loaded without them — and the answer is
stored. Deriving it per render was tried first and rejected in use: the arrow jumps from one
point to another as a box is dragged past a diagonal, which is not useful to anyone.

This is the same shape as `placeNode`: seed once, never re-solve. An edge whose ends keep
being recomputed is the edge equivalent of a layout engine re-running over a pinned node.

The canvas writes them with `add_edge_at`, the layout twin of `add_edge`, for the same reason
`add_node_at` exists: a human dragging between two points has said where the ends go and an
agent has not, so keeping the sides off `add_edge` is what stops an agent expressing them.
One op, so drawing an edge stays one undo step. `attach_edge` moves an end afterwards, and
`auto` releases it back to computed.

`add_edge_at` is `kindOf` **structural** — it creates an edge, which is always the message.
`attach_edge` is `layout`: it only changes which point a line touches. Same split as
`add_node_at` versus `move_node`.

A reconnect keeps the pin on the end that did *not* move and releases the one that did, since
a point only means something for the node it was pinned to.

**The face test must weight each delta by the other dimension.** `|dx| > |dy|` puts the arrow
on the top face of a box it is sitting beside, because a 900px-wide pinned node is exited
through its side long before the 45° line says so. Compare `|dx| * h` against `|dy| * w`.

**Computed faces make a reciprocal pair one line.** A→B and B→A now pick the same two faces,
so without the perpendicular offset they draw exactly on top of each other — worse than the
stacked-labels problem the offset originally existed for. The offset displaces the bezier
*control* points, never the ends, and the label rides the bowed path. Shifting the endpoints
was tried first and walked them off the face onto the corners (#15): on an 80px node, 24px
from the midpoint is most of the way to the corner. The e2e guard asserts each end against
its face midpoint.

**An auto-started server must be detached with its stdio dropped.** On this transport stdout
*is* the MCP protocol, so an inherited stdout interleaves server logs into JSON-RPC and kills
the session. Detached also means the human's canvas survives the agent restarting, and it
inherits the agent's cwd so diagrams land in the project rather than beside the MCP server.

**The drawn line and React Flow's interaction anchors must come from the same place.** The
canvas once derived its own endpoints while leaving each edge unbound, so React Flow used the
first handle it found and put the reconnect anchors ~120px sideways and ~84px above the
visible line. The line looked perfect and could not be grabbed at all — every test asserted
where it was *drawn*, which was right. `GraphCanvas` now sets `sourceHandle`/`targetHandle`
from the stored sides, and `DirectedEdge` draws from the props React Flow hands it. Never
compute an endpoint the framework also computes.

**A canvas measured with `offsetWidth` disagrees with React Flow by the border width.** React
Flow places handles from `getBoundingClientRect`, so a 1px border puts the two 2px apart.
An e2e assertion pinned to the exact pixel fails on that alone; the bug worth catching — an
end sliding onto a corner — is tens of pixels, so allow a few.

**Auto-start adopts; it never assumes.** A port already answering Crosspoint is used as-is,
and a port answering something else is reported rather than adopted — so the probe checks for
a `nodes` array, because "something responded" is not evidence that it is ours.

**The published tarball keeps the monorepo paths, and that is load-bearing.**
`bin/crosspoint.js` resolves `packages/server/dist/index.js` relative to the package root, and
`static.ts` resolves `../../web/dist/` relative to itself. Flattening either into a plain
`dist/` at publish time breaks both, silently — the tarball installs and the command dies
looking for a canvas. The `files` list in the root `package.json` therefore names those two
paths verbatim. It also has to exclude `*.test.*`, or the server's tests ship to every user.
Every published package needs that exclusion, not only the root — `@crosspoint/mcp` had
`files: ["dist"]` and packed `autostart.test.js` until 0.3.0.

**`npm version -ws` does not update the range a dependent asks for.** Bumping every package
to 0.2.0 left the root's `"@crosspoint/core": "^0.1.0"` untouched, and locally it kept working
because npm links the workspace regardless. Published, it resolves nothing — the CLI installs
and cannot start. Bump the range by hand every time, and pack-and-install to check.

**A dependency on the root package resolves from the registry, so its range cannot name the
version being released.** `@crosspoint/mcp` depends on `crosspoint`, which is not a workspace
member — npm downloads a published copy even in this checkout. Setting that range to `^0.3.0`
during the bump failed `npm ci` with `ETARGET`, and `npm ci` runs *before* the publish step
that would have created 0.3.0: the tag build died asking for the thing it was about to make.
The range is a floor, `>=0.2.0`, for exactly that reason — it resolves today, gives a user the
newest CLI, and needs no bump next time. The root's caret on `@crosspoint/core` is a workspace
link, so it has none of this and still must be bumped by hand.

**A 404 from `npm publish` means "we do not know who you are", not "no such package".**
Trusted publishing needs three things at once: `id-token: write`, npm 11.5.1+, and a trusted
publisher configured on *each* package at npmjs.com — repository, workflow filename, blank
environment. Miss any one and the PUT goes out anonymous, and the registry reports an
anonymous PUT as `404 Not Found`, which reads as the package not existing. `setup-node`'s
`registry-url` is the subtle way to miss it: it writes `_authToken=${NODE_AUTH_TOKEN}` into
.npmrc, and an *empty* value still reads to npm as "auth is configured", so it never starts
the OIDC exchange. The workflow omits `registry-url` for that reason; `npm publish` defaults
to registry.npmjs.org without it. The log tell is the absence of any OIDC line, and the
provenance statement being signed proves nothing — that uses the Actions token, not npm's.

**A staged publish reads exactly like a real one, and a green job proves nothing.** A trusted
publisher allows `npm publish`, `npm stage publish`, or both, and stage is always allowed — so
a connection created without direct publish turns `npm publish` into a *staged* version that
prints `+ @crosspoint/core@0.3.0` and exits 0 while the registry 404s that version. 0.3.0
shipped that way: core was stage-only, the CLI and the MCP server were not, so `crosspoint`
went live asking for a `@crosspoint/core@^0.3.0` that resolved to nothing. That is the failure
the publish order exists to prevent, arriving through a door the order cannot close — ordering
the commands does nothing if one of them does not publish. Approval needs proof of presence and
cannot use the OIDC token, so CI can never finish it; a human approves it on npmjs.com or with
`npm stage approve`. Keep the three connections configured alike, and check a release against
the registry — `curl -o /dev/null -w '%{http_code}' registry.npmjs.org/<pkg>/<version>` and a
real install in an empty directory — never against a green workflow.

**Node under QEMU dies with SIGILL, so the image's target stage must never run it.** The
arm64 half of the multi-arch push is emulated on an x86 runner, and `npm ci` in the runtime
stage exited 132 with `qemu: uncaught target signal 4`. Every runtime dependency is pure JS,
so the build stage is pinned to `$BUILDPLATFORM`, installs and prunes natively, and the
target stage only copies files. It passed for weeks before failing, so a green run is not
proof the shape is right; a `RUN` that executes node in the second stage is the tell.

**A `files` entry beats `.gitignore`, which is why publishing a gitignored `dist` works.** It
reads wrong every time. `npm pack --dry-run` is the only answer worth trusting; check it
after touching `files`.

**`*/` inside a comment closes it, even in a path.** Writing `` `packages/*/dist` `` in a
JSDoc block ended the comment at the `*`, and the rest of the line became code — a stray
backtick then reported as `TS1160: Unterminated template literal` 30 lines below, at EOF. Say
"the sibling `dist` directories" instead.

**Never write non-UTF8 bytes into source.** Two literal NUL bytes used as a separator in a
template literal worked fine at runtime but made git classify the file as *binary* — diffs
became `Bin 6794 -> 7788 bytes` and grep skipped the file entirely.

**Each `<ReactFlow>` needs its own `ReactFlowProvider`.** `useReactFlow` resolves to the
nearest one, so the lens panel sharing the main canvas's store would pan and zoom the canvas
*behind* it instead of itself — and `screenToFlowPosition` would convert against the wrong
viewport, creating nodes in the wrong place.

**A canvas must send its own diagram with every op.** `GraphCanvas` is shared between the main
view and the panel, so an op that omits its target silently lands in whatever is *active* —
which for a panel is never the diagram it is showing. That corrupts the diagram the human is
looking at while appearing to work. The e2e test that catches it fails alone when the argument
is dropped; keep it that way.

**Selection has to carry its diagram.** The colour palette lives in the header while the
selection may be inside a panel, so a bare list of ids is not enough to know where to write.
It also has to distinguish nodes from edges: colouring them takes `update_node` against one
and `update_edge` against the other, so a flat id list leaves the caller unable to tell which
it is holding.

**The actor on a log entry is inferred from the transport, never supplied by the caller.**
A websocket op is the canvas, so `human`; an op to `/api/op` is the MCP server or a script, so
`agent`; an external file edit is a person working outside the app, so `human` too. Do not
"simplify" this into a client-supplied `actor` field — a caller can lie about it or forget it,
and a wrong attribution is worse than none, because `get_changes` defaults to human-only and
would then hide a real instruction. `Workspace.apply` takes `actor` as a **required** option so
that adding a third transport is a compile error rather than a silent misattribution.

**An entry with no actor is kept by every filter.** Logs written before attribution existed are
unattributable, not anonymous. Dropping them would make a real history look empty the first
time someone upgraded; showing a change that might not be the human's is the smaller error.

**Filtered feed entries are still consumed.** This holds for the actor filter exactly as it
does for the layout filter: they are dropped from the *response*, not left unseen, or a
no-argument read would re-scan the same agent ops forever and never converge. There is a test
per filter for this.

**The server can read back its own write and call it someone else's.** `persistNow` sets
`lastWritten` *before* the rename lands, so for the length of that write the file still holds
the **previous** text — ours, but no longer what `lastWritten` compares against. A watcher
event in that window was adopted as an external edit: the diagram reverted to the older
content and a phantom step went onto the undo stack. `reload` now ignores anything whose
`rev` is older than what is already in memory, which can only be that echo; a hand edit leaves
the rev alone, so it still reads as current. Found by CI, not by the author's machine — it
needed a fresh build competing for CPU to surface, and it failed roughly one run in ten.

**`window.prompt` is banned in this canvas.** It blocks the page, cannot be styled, and the
user rejected it outright after being interrupted by one on every node creation. There were
four; all are now inline inputs (`LabelInput`). `grep -rn "window.prompt" packages/web/src`
should stay empty.

**A node being created must not exist on the server until it is named.** The draft is
client-side and commits as a single `add_node_at`. Creating an empty node and renaming it
would put `+ node ""` then `~ node relabelled` into the change feed for *every* creation —
noise in the one channel that exists to carry meaning — and an abandoned draft would leave
junk behind needing a third op to remove.

**`rows` counts typed lines, not wrapped ones.** One long paragraph with no breaks in it
asked for a single row and then scrolled inside it. `LabelInput` sizes a body from
`scrollHeight` after layout instead, which is the only number that knows where the text
actually wrapped.

**A mutation test can match its pattern and still prove nothing.** Removing the autosize left
the growth test green, because the node it used was *pinned* — `cp-sized` stretches the
editor by CSS and hid the defect entirely. The pattern matched; the scenario was wrong. The
test now uses an unsized node, and removing the autosize fails it with "76px of content in
25px". When a mutation does not fail a test, suspect the fixture before the guard.

**A native browser binding is not `Meta` on every platform; an app handler is.** `Meta+A`
selects all on macOS and does nothing on Linux, where select-all is Ctrl+A. A body-edit test
pressing it passed on the author's machine and failed every CI run — the selection never
happened, so the typed text was appended to what was already there and the assertion waited
for a body that never arrived. Use `ControlOrMeta` for anything the *browser* interprets;
`Meta+Enter` in the same test is fine because `LabelInput` reads `metaKey || ctrlKey` itself.
It only began failing when the multiline caret collapsed to the end: while the field selected
all on focus the modifier did nothing, so being wrong about it could not show.

**Select-all on focus is right for a name and wrong for a body.** You open a name to retype
it; you open a body to add to it, where one keystroke over a full selection destroys
everything already written. `LabelInput` collapses the caret to the end when `multiline`.

**An inline input focuses on the next frame, so a test must wait for focus.** `LabelInput`
defers focus with `requestAnimationFrame` to win a race against React Flow's own handler.
Keystrokes sent straight after the field appears go to the document instead — `keyboard.type`
is slow enough to mask it, a single `Meta+A` is not. The e2e suite has an `awaitFocus` helper;
use it.

**`innerText` is empty on a node React Flow has not shown yet.** A freshly measured node is
kept `visibility: hidden` for a frame, and `innerText` honours that, so a test that waits for
the element and then reads its text sees `''` about one run in three. Read `textContent`, and
wait on the value rather than on the element existing.

**A labelled, selected edge has its × over the path midpoint**, so a positional double-click
on the edge lands on delete instead of opening the editor. Dispatch the event to the element
when the point is contested, and keep one positional test to prove the edge is hittable.

**Undo is snapshots, not inverse ops, and the stacks are per diagram.** Inverting
`delete_node` needs the cascade-removed edges, `generate_graph` with `replace` needs the whole
prior graph — all of which means storing prior state anyway. `rev` counts the workspace but
history must not, or one Cmd+Z would silently alter a diagram nobody is looking at. A revert
inherits its target's `kind`, so undoing a drag is feed noise and undoing an added node is not.

**Two independent layers stop Cmd+Z reverting the graph while a label is being edited**, and
that is deliberate. `LabelInput` calls `stopPropagation` so the document listener never fires
at all; the listener *also* checks `document.activeElement`. Removing either alone keeps the
e2e test green — removing both fails it. So do not delete one as "dead code": it is only
unreachable while the other holds, and the failure it prevents is destructive (mid-rename, the
node you are renaming is exactly what an errant undo removes).

**A mutation test that does not assert its pattern matched proves nothing.** A `str.replace`
that silently finds no match leaves the code intact, the suite green, and the false impression
that a guard is unnecessary. That happened here and briefly hid which layer was load-bearing.

**An inline input must stop its own key events.** React Flow listens for Backspace and Delete
to remove the selection and for space to pan, so typing a label would delete the node being
renamed. `LabelInput` calls `stopPropagation` on every key event; there is an e2e test that
presses Backspace in the field and asserts the node survives.

**v12 has no pane double-click callback.** Node creation listens for `dblclick` on a wrapper
div and filters to `event.target.classList.contains('react-flow__pane')`, or double-clicking a
node to rename it would also drop a new node behind it. `zoomOnDoubleClick` must be `false`
too, or the canvas zooms out from under the caret.

**Edge colour needs its hex in JavaScript, unlike node colour.** An arrowhead is an SVG
`<marker>` whose colour React Flow bakes into the marker definition, so a stylesheet cannot
reach it — a coloured line ending in a grey arrow reads as a bug. The values live in
`packages/web/src/colors.ts` and mirror the node *border* colours in `styles.css`.

**Selection must not repaint a coloured edge.** The palette acts on the selection, so the edge
just coloured is selected by definition; overriding its stroke would make applying a colour
appear to do nothing until you clicked away. Selection thickens instead, and only tints an
edge that has no colour of its own.

**`path.normalize` collapses a leading `..` on an absolute path.** Normalising before the
containment check turns `/../../etc/passwd` into `/etc/passwd`, joins it back inside the root,
and the check can never fail — the guard becomes dead code that reads as working. Reject `..`
segments *first*, then check containment as a second line. `safeJoin` in
`packages/server/src/static.ts` does it in that order, and deleting the rejection fails two
tests.

**A traversal test over HTTP cannot reach that guard.** `new URL()` normalises `..` out of the
pathname before the server sees it, so every wire-level attempt arrives already flattened and
returns the `index.html` fallback. `safeJoin` is therefore unit-tested directly; an
integration-only test would pass with the guard removed.

**Static serving must run after every `/api` route**, or a missing endpoint answers with HTML
instead of a JSON 404. And a missing *asset* must 404 rather than fall back to `index.html` —
serving HTML for an absent script turns a 404 into a syntax error, which is far harder to read.

**`fitView` animates, so a click before it settles is thrown away.** Measured across a diagram
switch: the viewport transform moves for ~250ms while the first node's x travels 102 -> 562. A
click computed from a bounding box taken in that window lands ~460px off and is simply
discarded — which surfaces as "selection is broken" or a bare timeout, never as a race. Three
separate flaky tests had this one cause. `openCanvas` now calls `settleViewport`, and every
diagram switch must too.

**The canvas has no error surface.** A dropped interaction just does nothing. Three separate
defects were invisible for exactly this reason. Verify canvas changes by driving a real
browser and asserting against the HTTP API — not by reasoning about the code.

**The lens panel is draggable by its header, and that had to be a bug fix.** Anchored beside
its node it covers the part of the parent it exists to keep visible. A dragged position wins
over the anchor and persists per diagram in localStorage; double-clicking the bar clears it.
Only the bar starts a move — the crumbs and close button are buttons, and the body is a live
canvas that keeps its own panning.

**The centre of a small subgraph is on an edge, not on the pane.** A drag there grabs the edge
and nothing pans, which reads as "panning is broken". Probe with `elementFromPoint` and grab a
corner: `react-flow__pane` is what you want under the cursor.

**The lens panel must be `position: fixed`.** Its `left`/`top` come from a screen-pixel
anchor clamped against `window.innerWidth`/`innerHeight`. While it was `absolute` those
coordinates resolved against a positioned ancestor below the header, so the panel rendered
~51px lower than computed and its bottom fell off a short viewport — which made the resize
grip literally unclickable at 1280x800 while working fine at 1300x900.

**When a browser interaction "does nothing", hit-test the point before debugging the
handler.** `document.elementFromPoint(x, y)` returning `nothing` means the coordinate is
outside the viewport, which is a positioning bug, not an event-wiring bug. The e2e resize
helper asserts this and reports the viewport and panel geometry on failure; keep that.

**`applyOp` returns the graph it was given when nothing changed, and `===` is the contract.**
The canvas snaps drags to the same 15px grid the model does, so a nudge inside one cell asks
for the position the node already holds. `Workspace.apply` compares by reference and skips the
rev, the history step, the log entry, the write and the push — a deep-equal check would not do,
since every other op returns a document that differs only by rev. Absorbing is deliberately
*not* an error: the caller did nothing wrong and the node is where it asked for it to be.

Two consequences. Only the snapped layout ops can be absorbed, so the comparison stays exact
rather than a deep equality over the whole graph. And **a test that moves a node to where it
already is now logs nothing** — one already existed in `oplog.test.ts`, reusing a coordinate
from earlier in the file, and it lost an entry the moment this landed. Pick fixture
coordinates that differ from the current position.

**Deleting a node must not also send `delete_edge` for that node's own edges.** The server
cascades them, so the second op names an edge that no longer exists. Separate
`onNodesDelete`/`onEdgesDelete` callbacks cannot see each other's list, so the best they could
do was rely on React Flow calling the edge one first — which it does, which is why this looked
fine for a long time. React Flow's combined `onDelete` hands over both lists at once, so the
redundant op is never sent and the order stops mattering. The e2e guard asserts one op reaches
the feed, because a canvas with no error surface shows nothing either way.

## Built since the reframing

Check the code, not this list, for what exists — but these are done and covered by tests:
the op log behind `get_changes`, `generate_graph` with dagre, named diagrams with a switcher,
node colour, semantic layout ops (`align`, `distribute`), subcanvases with the lens panel, and
the Playwright suite in `npm test`.

### Subcanvases

A node's `data.subcanvas` names another diagram holding its detail. Called `subcanvas` and not
`diagram` deliberately: an op also carries a *target* diagram — which one to write to — and two
different meanings one word apart is a trap.

The lens badge exists on **every** node but is only visible at rest when the node has a
subcanvas, appearing on hover otherwise, which is how you create one. Both facts matter: a
badge only rendered on linked nodes would leave creation with no affordance, and a badge always
visible would stop the canvas showing at a glance which steps have detail behind them.

The panel is the *same* `GraphCanvas` component as the main canvas, not a preview. That is
deliberate — the requirement is that a subcanvas is fully editable, and anything reimplemented
for the panel would drift out of step silently.

Two circular cases are refused with a visible message: opening the diagram you are already in,
and opening one already further up the trail. Both would give two live editable views of one
graph, each fighting the other's pushes.

Deleting a linked node **orphans** the subcanvas. The graph model has no power to reach another
file, so this is true by construction rather than by a check — one click must not be able to
discard an hour of sub-planning.

## Designed and agreed, not yet built

Check the code before trusting this list; it records decisions, not status.

- **Batched edits** — the user edits freely and nothing happens until they say go; the agent
  then reads the accumulated diff. Never act on a change the moment it lands.

## Parked decisions

Agreed in principle, deliberately not acted on yet:

- reverting `get_graph` to structure-only, so coordinates vanish from the agent's *reads* as
  well as its writes
- splitting `core` into `structure/` and `layout/` so layout code stops sitting in the middle
  of the graph model

## Known gaps

None outstanding. The two that stood here — a no-op `move_node` from a sub-grid nudge, and a
redundant `delete_edge` alongside `delete_node` — are fixed, and both left a trap above.
