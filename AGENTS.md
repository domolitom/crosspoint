# Crosspoint

## Communication Preferences

- Dry, concise, low-key. No flattery, no preambles or postambles.
- Comments explain "why", not "what". Match the density of the comments already there.
- Error messages: actionable and specific. A missing build should say what to run, not
  raise a module-not-found stack trace.

## Constraints

- **Never `git add` a diagram.** `graph.json`, `diagrams/`, `*.ops.jsonl` and `*.state.json`
  are live documents the server rewrites on every edit. Never `git add -A` in this repo.
- **Coordinates never reach the agent's write surface.** `StructuralOp` carries no
  coordinates and `LayoutOp` does; only structural ops are exposed over MCP. There is
  deliberately no `move_node` tool. A `position` field on `add_node` would destroy the
  invariant silently — the escape hatch is semantic intent (`align`, `distribute`), which the
  server resolves into geometry.
- **Tests run against `dist/`, not `src/`.** Use `npm test`, or
  `node --test packages/<pkg>/dist/*.test.js` for one file. Never `node --test <dir>/` — it
  reports success on zero matches, and once silently passed a suite that found no tests.
- **`window.prompt` is banned in the canvas.** It blocks the page and cannot be styled.
  `grep -rn "window.prompt" packages/web/src` should stay empty; use `LabelInput`.
- **Never write non-UTF8 bytes into source.** Git reclassifies the file as binary, so diffs
  become `Bin 6794 -> 7788 bytes` and grep skips the file entirely.
- **The canvas has no error surface.** A dropped interaction just does nothing, and three
  separate defects were invisible for exactly this reason. Verify canvas changes by driving a
  real browser and asserting against the HTTP API — never by reasoning about the code.

## Contributor Guidelines

- Keep changes focused and reviewable. Split commits at package seams; each commit must
  build on its own.
- Very short commit subjects, prefixed with the package: `server: undo and redo per diagram`.
- Do not put `@mentions` or `fixes #...` keywords in commit messages.
- Do not add `Co-authored-by:` in commit messages.
- Add or update relevant tests. `packages/e2e` is the layer where every silent bug in this
  project has lived.
- `CLAUDE.md` holds the invariants and the traps, each paid for with a real bug. Read it
  before changing anything structural, and add to it when you pay for a new one.
