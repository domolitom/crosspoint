# Skills

Claude Code skills that ship with Crosspoint. They live here rather than only in a personal
`~/.claude/skills` so they travel with the repo and can be reviewed like anything else.

## Install

Symlink so a `git pull` updates the skill in place:

```bash
ln -s "$PWD/skills/plan-to-crosspoint" ~/.claude/skills/plan-to-crosspoint
```

Or copy it, if you would rather pin a version:

```bash
cp -r skills/plan-to-crosspoint ~/.claude/skills/
```

Then `/plan-to-crosspoint`, or just ask for a plan as a diagram and it triggers on its own.

## What is here

- **`plan-to-crosspoint`** — draw the current plan, algorithm or architecture as a live diagram,
  then read the user's edits back as instructions. It covers both halves deliberately: drawing
  a picture and walking away is the failure mode this project exists to avoid.

A skill only tells the agent *how* to use Crosspoint. It still needs the server running and the
MCP server registered — see the README.
