# Gizmo Skills Registry

Reviewed, pinned snapshots of third-party Agent Skills packaged as installable Gizmo registry entries.

## Packages

- **pstack Skills** — vendored from `cursor/plugins/pstack/skills`
- **Matt Pocock Skills** — vendored from `mattpocock/skills/skills`

Exact upstream commits are recorded in `upstream-lock.json`. Upstream licenses and READMEs are retained with each package.

## Compatibility

The skill text is preserved from upstream. Some skills assume Cursor, Claude Code, Codex, particular model names, shell scripts, external CLIs, or harness-specific subagents. Review a skill before enabling it. Gizmo only executes JavaScript and TypeScript helper scripts through `run_script`; shell helpers are not directly executable through that tool.

Both collections contain a skill named `tdd`. Enabling both copies at once causes Pi's normal duplicate-name resolution to keep the first discovered copy.

## Install

Add this repository path in **Settings → Extensions**:

```text
C:/Users/mchan/projects/gizmo-skills-registry
```

Then install either collection and enable only the individual skills you want.
