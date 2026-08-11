---
name: pablo-toolkit
description: >
  Use when working with any pablo-* skill (goal-discovery, code-planning,
  tdd, code-philosophy) or any multi-step work that edits files, including
  academic documents. Session-scoped transparency: before each delegation it
  asks whether to preview the exact prompt; after each step that modifies
  files it shows a tree view of what changed (incremental by step, cumulative
  on request); agent responses are digested into key findings. Invocable by
  name: pablo-toolkit.
---

# pablo-toolkit

Transparency conventions for multi-step work: prompts sent to subagents,
files changed in this session, and findings from agent responses. Everything
is relative to the current session - the task in progress, wherever it lives
(pi-simple-agents, skills, documents) - not to any skill.

## Session working directory

All pablo-* skills share the current pi session's working directory for
session-scoped artifacts. Resolve it once at the start of the pass:

```bash
SESSION_DIR=$(python3 <skill-dir>/scripts/pi_session.py)
```

`<skill-dir>` is the directory this SKILL.md was loaded from. Persistent
sessions keep artifacts next to the session file
(`<session-storage>/<project>/<session>.files/`); ephemeral sessions fall
back to `/tmp/pi/session/<PI_SESSION_ID>`.

## Scope: session-relative

- The toolkit tracks the current session's file changes: what the session
  has modified so far, in the working tree where the session operates.
- [NEVER] report changes outside the session's work (unrelated user edits,
  other repos) unless asked.

## Before each delegation: ask for prompt preview

Before sending a task to a subagent, [ALWAYS] ask the user whether they want
to see the exact prompt first:

- `¿Muestro el prompt antes de delegar? (sí / no)`
- If yes: emit the prompt verbatim in a quoted block, wait for approval, then
  send.
- If no: delegate directly.
- The prompt sent is [ALWAYS] the one shown - no silent rewrites after
  preview.

## After each step that modifies files: tree view

After every step that modified files, emit a tree view of what changed in
this session:

- **Incremental by default**: only the files touched in that step.
- **`ver cambios` / "show changes"**: cumulative tree of the whole session
  so far.
- Format: 2-3 level tree, directories collapsed, markers:
  - `+` new file
  - `M` modified
  - `D` deleted
- If the step modified no files: emit nothing (silence).
- The tree view applies at any step boundary that modified files, including
  document work (markdown, docx conversions, findings files).

## Key findings digest

When a subagent returns (worker, analyst, scout, web-scout, planner):

- Present the response's load-bearing findings as bullets, not narrative.
- [NEVER] repeat the full response verbatim.
- If the response has no findings (e.g. a lookup miss), say so in one line.

## Deferrals visible

Keep visible the list of what was deferred and why - process debt is never
lost. Present as:

- `Deferral: <item> - <reason> - <revisit when>`

## Continuation block (session close)

When the user closes or hands off the session, emit a verbatim fenced block
to resume in a fresh session:

```
[Session state: last step, artifacts, current file tree of changes]

[Next step / open questions]

[Deferrals]
```

## Anti-patterns

- Adding domain knowledge - that belongs to the pablo-* skills, not here.
- Repeating full agent responses.
- Showing the prompt automatically without asking first.
- Emitting the tree view when nothing changed.
- Emojis - this skill stays plain text (the goal-discovery grilling is the
  only pablo-* skill with emoji markers, by explicit user decision).
