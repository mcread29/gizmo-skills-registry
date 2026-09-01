# Gizmo Skills Registry

Reviewed, pinned snapshots of third-party Agent Skills packaged as installable Gizmo registry entries.

## Packages

- **pstack Skills** — vendored from `cursor/plugins/pstack/skills`
- **Matt Pocock Skills** — vendored from `mattpocock/skills/skills`

Exact upstream commits are recorded in `upstream-lock.json`. Upstream licenses and READMEs are retained with each package.

## Updating upstream snapshots

Refresh both vendored collections to their upstream default branches:

```bash
node scripts/sync-upstreams.mjs
```

Preview available updates without changing the registry, or update one collection:

```bash
node scripts/sync-upstreams.mjs --dry-run
node scripts/sync-upstreams.mjs --only pstack
node scripts/sync-upstreams.mjs --only matt-pocock-skills
```

The script stages and validates every selected upstream before replacing any vendored files. It updates each commit in `upstream-lock.json` and refuses snapshots without `SKILL.md` files.

`.github/workflows/sync-upstreams.yml` runs every Monday and can also be dispatched manually. When upstream commits change, it force-updates a dedicated automation branch and opens or refreshes a pull request for review.

## Compatibility

The skill text is preserved from upstream. Some skills assume Cursor, Claude Code, Codex, particular model names, shell scripts, external CLIs, or harness-specific subagents. Review a skill before enabling it. Gizmo only executes JavaScript and TypeScript helper scripts through `run_script`; shell helpers are not directly executable through that tool.

Both collections contain a skill named `tdd`. Enabling both copies at once causes Pi's normal duplicate-name resolution to keep the first discovered copy.

## Install

Add this repository path in **Settings → Extensions**:

```text
C:/Users/mchan/projects/gizmo-skills-registry
```

Then install either collection and enable only the individual skills you want.
