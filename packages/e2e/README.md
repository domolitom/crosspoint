# @crosspoint/e2e

Browser tests for the canvas.

```bash
npm run test -w @crosspoint/e2e        # the whole suite, ~22s
node --test packages/e2e/dist/lens.test.js               # one slice, ~4s
node --test --test-name-pattern "multi-node drag" packages/e2e/dist/canvas.test.js
```

Six suites, split by concern so iterating costs seconds rather than the whole run:

| file | covers |
| --- | --- |
| `canvas` | dragging, connecting, selecting and deleting; the diagram switcher |
| `colour` | node and edge colour, and the swatches themselves |
| `lens` | subcanvases, the panel, its trail and its geometry |
| `editing` | inline text: creating, renaming, edge labels, label-driven sizing |
| `resize` | pinning a node's size by hand |
| `undo` | Cmd+Z and Cmd+Shift+Z |

Each file boots its **own** stack — about 0.7s — so they must not run in parallel: they
share ports 4477/5477. That is what `--test-concurrency=1` in the package's test script is
for. It was already there for flakiness; it is now load-bearing for the ports too.

Anything more than one suite needs lives in `harness.ts`. `fixtures(() => stack)` returns
the shared `seed`, `freshDiagram`, `nodeById` and `awaitFocus`, bound through a getter
because each suite assigns its stack inside `before`.

Needs `npm run build` first — the suite runs the *built* server and drives vite, and the
tests themselves compile to `dist` like every other package here.

## Why this package exists

**This is the layer where every silent bug in this project has lived**, and the core and
server suites reach none of it. All of these shipped broken and were found by a human
clicking around, not by a test:

- `onEdgesChange` was missing, so edges could never be selected and Delete had nothing
  to act on
- `deleteKeyCode` defaults to Backspace alone, so the Delete key did nothing
- `OnNodeDrag`'s third argument was ignored, so a multi-node drag persisted only the node
  under the cursor and the rest silently reverted
- the node rebuild picked out `label` and dropped every other `data` key, so colour
  reached the browser and vanished on the next server push
- all seven colour swatches rendered as identical grey pills **while every colour
  assertion passed**, because the assertions measured nodes rather than buttons

That last one is the standard to hold: **assert on the thing a human would look at.** A
test that measures a proxy can pass while the screen is visibly wrong.

The canvas has no error surface — a dropped interaction just does nothing — so reasoning
about the code is not evidence that it works. Driving a real browser is.

## How it is isolated

Each run boots its own stack: the built server on port 4477 with a graph file in a fresh
`mkdtemp` directory, and vite on 5477 with `CROSSPOINT_SERVER` pointed at it. It never
touches the repo's `graph.json` and never assumes your dev server is running, so running
the tests can neither destroy your working diagram nor be confused by its state.
Teardown uses `SIGKILL` and waits for the ports to close — a stray server holding a port
has broken a run here before.

## Two traps worth knowing

**Measure `offsetWidth`, not `getBoundingClientRect().width`.** The latter is measured
through React Flow's zoom transform, so `fitView` on a wide graph reports a 120px node as
~66px, and a width assertion fails against an app that is perfectly correct.

**Reconnection is driven by React Flow's own anchor**, a transparent circle with class
`react-flow__edgeupdater-target` sitting at the edge end. Dragging the *node's* handle
instead starts a brand-new connection — a different gesture that will not reconnect
anything.

## No synthetic events left

HTML5 drag-and-drop cannot be driven by Playwright's mouse — `dataTransfer` only exists on
real drag events — so the palette test that used to live here dispatched
`dragstart`/`dragover`/`drop` by hand. The palette has since been replaced by
double-click-to-create, which is real mouse input, so every interaction in this suite is
now driven the way a human drives it.
