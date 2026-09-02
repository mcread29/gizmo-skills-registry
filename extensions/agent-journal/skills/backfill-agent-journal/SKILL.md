---
name: backfill-agent-journal
description: Import a repo's past Pi and Claude Code sessions into an append-only journal of markdown segments — a durable, greppable record of the conversations that produced the code, and the raw material a memory or knowledge layer derives facts from. Use when the user asks to backfill, import, or recover agent or coding-session history for a project, to build project memory from past conversations, to find out what was discussed or decided in earlier sessions, or to set up a transcript journal in a new repo. Also use when a memory system needs seeding with historical transcripts.
user-invocable: true
argument-hint: "[--dry-run] [--source pi|claude|both] [--out DIR]"
allowed-tools:
  - Bash(node *backfill-journal.mjs*)
---

# Backfill an agent journal

Turns the session transcripts already on this machine into `.agent-journal/` in
the current repo: numbered markdown segments plus an `index.jsonl`, one or more
segments per past session, oldest first.

The script has **no dependencies** and parses the session files directly, so it
works in any repo whatever that repo is written in. Node 18+ is the only
requirement.

## Run it

The script lives beside this file. From the repo you want to import:

```bash
node ~/.pi/agent/extensions/agent-journal/skills/backfill-agent-journal/scripts/backfill-journal.mjs --dry-run
```

Always dry-run first — it writes to a temp directory and reports what it would
import. Then drop `--dry-run` to write for real.

| Flag | Meaning |
|---|---|
| `--workspace DIR` | Repo to import for (default: cwd) |
| `--out DIR` | Journal location (default: `<workspace>/.agent-journal`) |
| `--source pi\|claude\|both` | Which transcript store to read (default: both) |
| `--dry-run` | Write to a temp dir and report; touch nothing real |

**Run it from the repo root**, or pass `--workspace`. Sessions are matched by
the working directory recorded inside each transcript, so pointing at a
subdirectory silently matches nothing.

## After importing

1. **Decide whether transcripts belong in git.** The script prints a reminder.
   Adding `.agent-journal/` to `.gitignore` is the safe default; committing it
   makes the history shared team knowledge and puts it in code review. Ask the
   user rather than guessing — full conversation logs may contain anything.
2. **Report the counts** the script prints, and note that re-running is safe:
   segments are keyed by source entry ids, so a second run imports only what is
   new. That makes this a periodic catch-up, not just a one-off.

## Where the transcripts come from

| Source | Location |
|---|---|
| Pi | `~/.pi/agent/sessions/<mangled-project>/*.jsonl` |
| Gizmo | `~/.gizmo/sessions/*.jsonl` |
| Claude Code | `~/.claude/projects/<mangled-project>/*.jsonl` |

Both tools nest sessions in a directory per project and mangle the project path
into the directory name. **Match on the `cwd` recorded inside the file, never
on the directory name** — the mangling is lossy and platform-dependent.

## Why the script looks the way it does

Each of these was a real failure found against real data. Preserve them if you
adapt the script.

**Claude Code puts tool results in `user` messages.** A `user` record whose
content holds `tool_result` blocks is not something the user said. Imported
naively, thousands of tool payloads get filed as user prose and bury the actual
conversation. They must be split out into tool results keyed by `tool_use_id`.

**Claude Code records slash-command plumbing as user messages** — the caveat
banner, the `<command-name>` envelope, the command's own stdout. Around 7% of
user messages in a real corpus. Dropped. `<system-reminder>` blocks are
injected context rather than speech, so they are stripped from otherwise real
messages.

**Pi session files are trees, not lists.** Reading them flat imports retried and
abandoned branches as duplicated prose. Walk the `parentId` chain back from the
newest entry to get the canonical branch, then reverse it.

**Subagent sidechains** (`isSidechain: true` in Claude Code) interleave
incoherently with the main thread and are skipped.

**Assistant turns can be empty**, carrying only a stop reason. Emitting a
`## assistant` header for them litters the output.

**Nesting.** A flat scan of either store's root directory finds zero files.

## What normalization keeps and drops

Prose written by the user or the assistant is **never** truncated — it is where
reasoning and decisions live. Tool arguments, reasoning blocks, and successful
tool output are truncated head-and-tail with a dropped-character count. Tool
**errors are kept whole**: they are short, and usually explain a later decision.

This is lossy on purpose. The original JSONL stays where it is; the journal is a
readable projection of it, not a replacement.

## Adapting it

The pieces are independent: `parsePiTranscript` and `parseClaudeTranscript`
produce a common entry shape, `normalizeSegment` renders it, and the store
functions handle numbering, idempotency, and atomic writes. To support another
agent's transcript format, write one more parser that emits the same shape —
`{ type: 'message', id, parentId, timestamp, message: { role, content } }` with
roles `user`, `assistant`, and `toolResult` — and leave the rest alone.

Segments are capped at 300 messages so a long session becomes several citable
chunks rather than one multi-megabyte file. Raise `MAX_SEGMENT_MESSAGES` for
coarser segments.

## Verifying an import

- `index.jsonl` has one line per segment file.
- Each segment's frontmatter carries `source:` (`pi-archive` or `claude-code`)
  and `trigger: backfill`, so derived facts can be traced to imported history
  rather than live capture.
- `grep -c '^## user' .agent-journal/*.md` — user turns should look plausible
  against how much work the repo has actually seen.
- Re-run the script: it should report everything as already imported.
