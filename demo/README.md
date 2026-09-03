# crosspoint-demo

A 50-second film about Crosspoint. Two commands:

```bash
npm install
npm run capture      # films the real app  -> public/*.mp4 + public/changes.json
npm run render       # composites the film -> out/crosspoint-demo.mp4
npm run studio       # iterate on the composition with live preview
```

`npm run capture` needs `npm run build` to have been run in the repo root — it launches the
**built** server, not the sources.

## Deliberately not a workspace

This directory is outside the root `packages/*` glob, so `npm install` at the root never
pulls Remotion. Remotion is also not open source in the way the rest of this repo is — free
for individuals and companies up to three people, paid above that — and nobody building
Crosspoint should inherit that just to have the tests pass.

## Every screen is the real application

`capture/record.ts` boots the built server on port 4600 and vite on 5600 against a throwaway
`mkdtemp` directory, then drives the canvas with real clicks, real typing and real
websocket round trips. Anything labelled as the agent goes over `/api/op`, the same HTTP
surface the MCP server uses.

That is not showing off. The canvas has no error surface — a dropped interaction just does
nothing — so a staged recreation of the UI could look flawless while the product was
broken. It also means the film cannot drift: re-run `capture` after a change and either the
film still works or the change broke something.

`public/changes.json` is the actual `/api/changes` response from the recording session, and
the feed scene renders it directly. Retyping that payload by hand would undercut the one
claim the film exists to make.

## What it argues

The round trip, not a feature tour: prose is lossy, a graph is not, and the graph is
editable by both sides — so the edit becomes the request. Shots, in order:

| shot | what it shows |
| --- | --- |
| `generate` | 31 nodes from one `generate_graph`, laid out by dagre |
| `lens` | three levels deep through subcanvases, and the trail back |
| `edit` | drag, double-click to create, name inline, colour red |
| (feed) | the real `get_changes()` diff — the drag filtered out as noise |
| `invariant` | the agent adds nodes and cannot move what you arranged |

## Two things that cost an afternoon

**Playwright's bundled ffmpeg only has libvpx.** `-encoders` lists VP8 and nothing else,
because encoding its own recordings is all it needs; asking it for libx264 dies with a bare
exit code 8. Remotion's compositor ships a full build — but its binary links its dylibs by
bare name, so it has to be run with `cwd` set to its own package directory or it aborts with
SIGABRT and no stderr at all, which reads exactly like a corrupt download.

**A context `deviceScaleFactor` of 2 against a browser pinned to 1 films a canvas that
decays.** The parent graph's edges vanish after about a second and the whole canvas goes
blank a few seconds later, while the DOM and the viewport transform stay perfectly correct
the entire time — so it looks like an app bug, and it is not. The footage is shown 1:1 in
the composition, so scale 1 was the right answer anyway.

## Re-filming one shot

```bash
npx tsx capture/record.ts lens        # only this shot; fixtures still get set up
```

Clip lengths are hard-coded in `src/Demo.tsx` as frame counts. Re-capture changes them, and
a mismatch shows up as a frozen last frame — which looks like a rendering bug rather than a
timing one. `ffprobe` the clip and update `CLIP`.
