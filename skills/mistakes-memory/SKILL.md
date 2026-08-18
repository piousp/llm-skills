---
name: mistakes-memory
description: >
  Record and recall directory-scoped LLM mistakes. The current directory's
  mistake log auto-loads at the start of work (via the global AGENTS.md hook);
  invoke by name (`mistakes-memory`) to LOG a new mistake or GRADUATE a
  recurring one into the repo's AGENTS.md. Every write requires explicit user
  confirmation. [DO NOT] trigger for general notes, TODOs, or non-error
  knowledge - those are not mistakes; [DO NOT] use it to write without the
  user's go-ahead.
---

# mistakes-memory

A per-directory log of past LLM mistakes, stored outside any repo so it is
never committed. The model [NEVER] decides on its own that something was a
mistake: the context comes from the **user**, or from `advisor` /
`critical-thinker` as references. Three flows: read (auto), write, graduate.

## Path resolution

Resolve the log path with the script - [NEVER] hand-build it:

```bash
MISTAKES=$(python3 <skill-dir>/scripts/mistakes_path.py)
```

`<skill-dir>` is the directory this SKILL.md was loaded from. The script owns
the cwd-key sanitization and creates the parent directory. The log lives at
`~/.pi/agent/mistakes/<cwd-key>/mistakes.md`, keyed by absolute cwd, no git
dependency.

## Entry conditions

- **Read** - automatic, driven by the `## Mistakes Memory` hook in the global
  `~/.pi/agent/AGENTS.md`. Load the log as context before acting.
- **Write** - explicit invocation by name, or a coordinator proposal after an
  `advisor` / `critical-thinker` call surfaced an error.
- **Graduate** - coordinator judgment that one mistake has recurred 3+ times.

[NEVER] let the model self-diagnose a mistake with no user or
advisor/critical-thinker basis.

## Read flow

If `$MISTAKES` exists, read it into context before acting so the directory's
past mistakes are visible. Surface silently.

- [NEVER] prompt the user during the read flow.
- [NEVER] re-read the file repeatedly in one session.
- [DO NOT] error when the file is absent - it just means no mistakes logged.

## Write flow

Assemble the entry from the template below. The 7 fields fall into three
classes - fill each by its own rule:

- **Substance** (`Symptom`, `Root cause`) - the existence and cause of the
  mistake. [NEVER] invent these: they come from the user, or from `advisor` /
  `critical-thinker`. With no basis for them, **ask** - the model [NEVER]
  self-diagnoses a mistake.
- **Factual** (`Fix applied`, `Source`, date) - fill only from evidence.
  `Fix applied` = what was actually done this session or what the user stated;
  if nothing was fixed, the literal value `pending` (a valid value - [NEVER]
  infer a fix that did not happen). `Source` = the **real** proposer (never
  write `user` over an `advisor`/`critical-thinker` finding). Resolve the date
  from the system (`date +%F`), [NEVER] from memory.
- **Derived** (title, `Tag`, `Detection cue`) - the model proposes these, and
  they [MUST] be visible to the user (see the confirmation rules below).
  Prefer **reusing an existing `Tag`** from the log over inventing a new one -
  an unstable tag scatters one recurring mistake and defeats graduation.

Then, to write:

- If the user already gave explicit go-ahead in the same request (e.g. "log
  it", "save it"), append directly - the confirmation is present - **but echo
  the full stored entry in the response** so the user can correct any derived
  field.
- Otherwise, [ALWAYS] show the drafted entry and get **explicit user
  confirmation** before appending.
- [NEVER] write on an `advisor` / `critical-thinker` proposal alone - the
  user is the authority.
- Append only; [NEVER] rewrite or drop existing entries.
- The log language is free (whatever the user/coordinator used).

### Entry template

```markdown
### <YYYY-MM-DD> · <short symptom title> · #<tag>
- **Symptom:** what was observed, how it manifested
- **Root cause:** why it actually happened, not the surface error
- **Fix applied:** what resolved it this time, or `pending`
- **Detection cue:** the signal that flags this recurring next time
- **Source:** user | advisor | critical-thinker
- **Tag:** <area/component>
```

If the file is new, open it with a one-line header before the first entry:

```markdown
# Mistakes — <cwd>
<!-- Private LLM mistake log. Not committed. Consolidate when > 40 entries. -->
```

## Graduation flow

Read `$MISTAKES` and **judge** whether one mistake has recurred 3+ times.

- [NEVER] add or rely on a counter field - the judgment is by reading the log
  (it stays short by design).
- If 3+ recurrences: [ALWAYS] propose promoting it to a hard rule in the
  **repo-root `AGENTS.md`**, under a `## Learned rules` section, **written in
  English** (create `AGENTS.md` if absent).
- Gate on **explicit user confirmation** before writing to `AGENTS.md`.
- The private log entry stays; graduation adds a committable rule, it does not
  move data out of the log.

## Consolidation

Past ~40 entries, [ALWAYS] *suggest* consolidating near-duplicate entries.
[NEVER] auto-prune or delete.

## Anti-patterns

- Writing without explicit user confirmation.
- The model self-diagnosing a mistake with no user/advisor/critical-thinker basis.
- Inventing a `Fix applied` that did not happen - use `pending`.
- Guessing the date from memory instead of the system clock.
- Overwriting the real `Source` (e.g. `user` over an `advisor` finding).
- Appending silently on same-turn go-ahead without echoing the entry.
- A counter field for recurrence - judge by reading.
- Graduating a rule in a language other than English.
- Auto-pruning or deleting entries.
- Embedding or semantic search - the memory stays a flat, scannable file.
