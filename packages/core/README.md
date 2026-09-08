# @crosspoint/core

The graph model behind [Crosspoint](https://github.com/domolitom/crosspoint): node and edge
types, `applyOp`, placement, `arrange`, dagre generation, and diff-stable serialisation.

Published so the `crosspoint` CLI can depend on it. The interesting part is the design
constraint it enforces — a `StructuralOp` carries no coordinates, so an agent holding only
structural ops cannot express a position and cannot overwrite the human's layout. See the
[repository](https://github.com/domolitom/crosspoint) for the whole story.

```bash
npm i @crosspoint/core
```

MIT.
