# Crosspoint graph format, v1

A diagram is one JSON file: a typed node/edge graph whose **layout is optional and belongs to
the human**. An agent writes structure. Positions are seeded by a server and then kept.

```json
{
  "rev": 12,
  "nodes": [
    { "id": "auth", "position": { "x": 120, "y": 60 }, "data": { "label": "Auth" } },
    { "id": "db", "position": { "x": 120, "y": 200 }, "size": { "w": 240, "h": 90 },
      "data": { "label": "Database", "body": "Postgres 16", "color": "amber",
                "code": { "file": "src/db.ts", "symbol": "pool", "lines": "10-42" } } }
  ],
  "edges": [
    { "id": "auth->db", "source": "auth", "target": "db", "label": "reads",
      "arrow": "both", "sourceSide": "bottom", "targetSide": "top" }
  ]
}
```

## Document

| field | type | notes |
| --- | --- | --- |
| `rev` | integer | monotonic; incremented per applied mutation. Stale writes are rejected. |
| `nodes` | array | insertion order is preserved and meaningful for diffs |
| `edges` | array | same |

## Node

| field | type | required | who owns it |
| --- | --- | --- | --- |
| `id` | string | yes | derived from the label by slugifying; stable once assigned |
| `position` | `{x, y}` | no | **layout.** Absent means "not placed yet". A reader must not require it. |
| `size` | `{w, h}` | no | **layout.** Absent means "size to content". Present means pinned. |
| `data` | object | yes | structure; see below |

`data` is an open bag with these known keys:

| key | type | notes |
| --- | --- | --- |
| `label` | string | required, one line; ids derive from it |
| `body` | string | multi-line detail; absent rather than `""` |
| `color` | name | one of `slate amber red green blue violet`; stored by name, never hex |
| `subcanvas` | string | name of another diagram holding this node's detail |
| `code` | object | `{ file, symbol?, lines? }`; `lines` is `"12"` or `"12-40"` |

Unknown keys are preserved verbatim.

## Edge

| field | type | required | who owns it |
| --- | --- | --- | --- |
| `id` | string | yes | `source->target`, made unique if needed |
| `source`, `target` | node id | yes | |
| `label` | string | no | |
| `color` | name | no | same palette as nodes |
| `arrow` | `both` \| `none` | no | absent means `forward` |
| `sourceSide`, `targetSide` | `top right bottom left` | no | **layout.** Which connection point each end is pinned to. Absent means computed. |

## Rules

1. **Layout fields are optional everywhere, and never required to read a document.** A file
   with no positions is valid. That is what lets an agent write one.
2. **Defaults are stored as absence, not sentinels.** No `color: "none"`, no `arrow: "forward"`,
   no `body: ""`.
3. **Enumerated fields are validated at the door.** An unknown colour, arrow, side or code
   reference shape is refused, not stored.
4. **Loading must not rewrite layout.** Hand-written coordinates pass through verbatim.
5. **Serialisation is diff-stable.** Fixed key order; `label` first in `data`, then
   alphabetical; arrays keep insertion order.

## Why not JSON Canvas

JSON Canvas 1.0 makes `x`, `y`, `width`, `height` mandatory on every node. A format that
requires geometry cannot be written by an agent that is barred from emitting it.

## Versioning

This is v1. A breaking change to a required field or a rule above bumps the version and adds
a `format` field to the document. Additive keys in `data` do not.
