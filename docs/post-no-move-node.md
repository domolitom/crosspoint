# Agents shouldn't be allowed to move your boxes

*Draft for a blog post / Show HN. Publish after the npm package and the demo are in place.*

Crosspoint is a diagram that an AI agent and a human edit together. The agent adds nodes,
draws edges, colours things. The human drags them around. Then the human's edits *are* the
next instruction: move a step, delete a box, and the agent reads the diff and implements it.

The interesting part is one missing tool.

## There is no `move_node`

The agent's write surface has sixteen tools. Not one of them takes a coordinate. `add_node`
takes a label and, at most, a `near: <id>` hint. There is no `position` field anywhere in the
schema, not discouraged, not approval-gated, just absent. The agent cannot express a position,
so it cannot overwrite one.

That sounds like a limitation. It is the whole product.

## Why layout is the human's

Where a box sits on the canvas is the one thing the human made with their hands. Every drag
is a small decision: this goes above that, these three belong together. An agent that re-runs
a layout engine over the graph destroys all of it in one call, and it will do that
mid-thought, every time it adds a node, because it has no idea what your arrangement meant.

So the split is by *who may issue an op*, not by what the op does. Structural ops (add,
connect, relabel, delete) are the agent's. Layout ops (move, resize, pin an edge to a point)
belong to the canvas. When a new node arrives from the agent, the server seeds a position for
it clear of everything else, and from then on that position is the human's.

## Why Mermaid and Graphviz can't have this

Text-to-diagram tools describe structure only. Layout is computed by the renderer at draw
time and never stored, so there is nothing for a human to own. Drag a Mermaid box and the next
render puts it back. Position-as-data formats like JSON Canvas store layout, but make it
mandatory, and a format that requires geometry cannot be written by an agent that never emits
it. Crosspoint stores layout and makes it optional. That is the gap it sits in.

## The exceptions, and why they are not leaks

**Colour** is on the agent's surface. Recolouring a node destroys no spatial work, and a
coloured node is usually a statement: amber for "needs attention", red for "broken". A
channel where only one side can make that statement is worse. Colour is stored by name, never
hex, and an invented name is refused.

**Semantic layout ops** are on the surface too: `align`, `distribute`, `generate_graph`. Each
names an intent and the server resolves it into geometry. No coordinate crosses the boundary.
That is the escape hatch for "tidy this up" without handing over a pixel.

## What it feels like

You ask for a plan. It appears as a graph. You drag a step to the other branch and delete one
you don't want. You say "do that." The agent reads two log lines, `moved retry` and
`− node fallback`, and goes and does it. The picture is how you talk. Nobody has to describe
the change in words, and nobody's arrangement gets flattened while they are looking at it.

Repo: https://github.com/domolitom/crosspoint · `npx crosspoint`
