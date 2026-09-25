# Changelog

Versions are git tags, npm versions and image tags alike: `v0.3.0` is `crosspoint@0.3.0` is
`ghcr.io/domolitom/crosspoint:v0.3.0`.

## Unreleased

- The state sidecar is written atomically, and an unreadable one is treated as absent.
- The diagram list in file mode is recovered from the op log as well as state.
- Creating a diagram is logged, so an unedited diagram survives a lost sidecar.
- The runtime image no longer runs node under emulation; the arm64 build was dying with SIGILL.

## 0.3.0 — 2026-09-14

- Nodes carry a multi-line `body`, editable in place and on the agent surface.
- Edges say which ends have arrowheads: `forward`, `both`, `none`.
- Edge ends are seeded onto a node's four connection points and stay there; drawn edges pin
  the points they were drawn onto.
- A pinned node grows to fit its text instead of clipping it.
- The MCP server starts the Crosspoint server when nothing is listening.
- Published via npm trusted publishing.

## 0.2.0 — 2026-09-08

- Published to npm: `crosspoint`, `@crosspoint/core`, `@crosspoint/mcp`. `npx crosspoint` works.
- Docker image for amd64 and arm64, and a one-command `compose.yaml`.
- An op that changes nothing costs no rev, no history step and no log entry.
- Deleting a node no longer also sends `delete_edge` for its own edges.
- The server no longer adopts a stale read of its own write.
- The e2e suite is split into six suites by concern.

## 0.1.0 — 2026-08-25

First tagged release. The graph model and ops, a server owning state over websocket, the
React Flow canvas, named diagrams, subcanvases in a lens panel, `generate_graph` via dagre,
an op log behind `get_changes`, semantic layout ops, and the MCP tools.
