# Contributing

Node 22+, npm workspaces, TypeScript throughout.

```bash
npm install
npm run dev        # server on :4000, canvas on :5173
npm test           # builds, then core + server + the browser suite
```

Tests compile to `dist/` first. One file:

```bash
node --test packages/core/dist/graph.test.js
node --test packages/e2e/dist/lens.test.js      # one browser slice, ~4s
```

Never `node --test <dir>/` — it reports success on zero matches.

## Layout

| package | what |
| --- | --- |
| `core` | the graph model: types, `applyOp`, placement, change feed |
| `server` | owns every diagram; HTTP + websocket on :4000 |
| `web` | the React Flow canvas |
| `mcp` | the agent's tools, a thin client of the HTTP API |
| `e2e` | Playwright against a real stack; where every silent bug has lived |

## The one rule

**Coordinates never reach the agent's write surface.** `StructuralOp` carries none, and only
structural ops are exposed over MCP. There is deliberately no `move_node` tool. A `position`
field on `add_node` would break this silently. Semantic ops (`align`, `distribute`,
`generate_graph`) are the escape hatch: the server resolves them into geometry.

Everything else that is easy to regress is in [CLAUDE.md](CLAUDE.md), each entry paid for
with a real bug. Read the relevant section before changing anything structural.

## A good PR

- Small commits split at package seams (`core: …`, `server: …`, `canvas: …`). Each builds alone.
- Very short commit subjects. No `Co-authored-by`, no `fixes #…`.
- Tests with the change. Canvas changes are verified by driving a browser, not by reasoning
  about the code — the canvas has no error surface.
- Never `git add` a diagram: `graph.json`, `diagrams/`, `*.ops.jsonl`, `*.state.json`.

## Browser suite

```bash
npm run test -w @crosspoint/e2e
```

Six suites, each booting its own stack on its own ports; they must stay serial. Fixtures live
in `packages/e2e/src/harness.ts`. If an interaction "does nothing", hit-test the point with
`document.elementFromPoint` before debugging the handler.
