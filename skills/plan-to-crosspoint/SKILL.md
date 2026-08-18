---
name: plan-to-crosspoint
description: Put the current plan, algorithm or architecture into a live Crosspoint diagram the user can edit, then read their edits back as instructions. Use when the user asks to see a plan as a diagram or graph, to visualise an algorithm or a system, or says something like "show me this as a graph", "put the plan in a diagram", or "diagram this".
---

Render the thing under discussion as a Crosspoint graph, then treat the user's edits to that
graph as instructions.

The diagram is not documentation. It is a channel: you draw, they rearrange, and the diff is
the next request. Drawing it and walking away is doing half the job.

## Before you draw

Check the server is up with `get_graph`. If it fails, the user needs to start it — in the
project they are working in:

```bash
node /path/to/crosspoint/bin/crosspoint.js
```

That serves the canvas and API on http://localhost:4000 and keeps diagrams in `./.crosspoint`.
Tell them the URL; a diagram nobody is looking at is useless.

If the MCP tools are missing entirely rather than failing, the client needs reconnecting —
changes to the Crosspoint MCP package do not appear until then.

## Drawing it

Use **one `generate_graph` call**, not a sequence of `add_node`s. It lays the whole graph out
hierarchically in a single revision; adding nodes one at a time produces a staircase and one
revision per node.

- **A diagram per topic.** `create_diagram` with a name that says what it is — `parser-cfg`,
  `auth-plan`. Do not pile unrelated things into one canvas.
- **`generate_graph` refuses a non-empty diagram** unless you pass `replace: true`. That guard
  exists so you cannot silently destroy someone's arrangement. If it refuses, ask before
  replacing — they may have work in there you cannot see.
- **Nodes are steps or components; edges are dependency or flow.** Put the relationship on the
  edge label — `calls`, `on failure`, `needs` — rather than leaving the reader to infer it.
- **Keep labels short.** They render in a box that caps at 320px and wraps. "Validate input"
  reads; a sentence does not.

### Colour carries meaning, so use it consistently

Colour is stored by name and reaches the user as a signal, so pick a scheme and say what it is:

| | |
|---|---|
| `green` | done |
| `amber` | in progress, or needs attention |
| `red` | blocked, broken, or a decision that cannot be unwound |
| `slate` | not started |
| `blue` | optional or informational |
| `violet` | a gate — something that must happen before the rest matters |

State the scheme in your reply. An unexplained colour is decoration.

### Nesting

When a step has its own internal plan, give it a subcanvas rather than inflating the parent:
`create_subdiagram` on that node, then `generate_graph` targeting the new diagram. The node
grows a lens badge the user clicks to open it in a panel beside the parent. Creating one does
**not** move the user's view, so say that you have added detail — otherwise they will not know
it is there.

## You cannot place anything, and that is deliberate

No tool accepts a coordinate. Layout belongs to the human; the server positions what you
create. If something needs tidying, use `align` or `distribute`, which express intent and let
the server compute geometry — and only when asked. Do not rearrange someone's diagram because
you think it looks untidy.

Practical consequence worth warning them about: hierarchical layout handles chains well and
handles **many edges converging on one node** badly — the labels collide in the band above it.
When you generate something with that shape, say so and suggest they drag the nodes apart.
That is the loop working, not a failure.

## Reading their edits — the half that matters

Call `get_changes` with no arguments to get everything since you last looked. It consumes, so
the next call returns only what is newer; pass `since_rev` for a repeatable read that does not
consume. Repositioning is filtered out by default, because where a box sits is rarely the
message.

Then:

- **Wait to be asked.** Do not act the moment an edit lands. The user edits freely and then
  says go; a half-finished thought is not an instruction.
- **Say what you think they meant before doing it.** "You added a retry branch and removed the
  cache lookup — so the fetch should retry rather than fall back?" A misread diff implemented
  in code is expensive; a misread diff read back aloud costs one sentence.
- **The feed does not record who made a change.** Your own `generate_graph` appears in it
  alongside their edits. If you generated the diagram this session, discount your own ops
  rather than reading them back as requests.
- **Keep it current.** When a step is finished, recolour it. A plan diagram that still shows
  everything as pending is worse than none, because it is confidently wrong.

## When not to use this

If the thing has no structure — a list of unrelated tasks, a single question — prose is better.
The diagram earns its keep when the shape matters: branches, cycles, a plan whose step 2 has
five steps of its own. Do not diagram something to look thorough.
