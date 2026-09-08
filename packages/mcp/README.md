# @crosspoint/mcp

The MCP server for [Crosspoint](https://github.com/domolitom/crosspoint). Gives an agent
sixteen tools for reading and editing a diagram — and deliberately no way to move a node:
coordinates are absent from every write tool, so the agent cannot express a position and
cannot overwrite the layout a human arranged.

```bash
claude mcp add crosspoint -s user -- npx -y @crosspoint/mcp
```

It is a thin client of the Crosspoint HTTP API, so **the server has to be running** or every
tool call fails. Start it with `npx crosspoint`. Point the client elsewhere with
`CROSSPOINT_SERVER` (default `http://localhost:4000`).

MIT.
