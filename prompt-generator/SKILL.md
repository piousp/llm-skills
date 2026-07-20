---
name: prompt-generator
description: >
  Sharpens a vague or under-specified ask into a paste-ready prompt for a fresh
  session, before any exploration or spec work begins.
---

# Prompt Generator

Always invoked by name. Sharpen the *prompt* before anything else touches it — no
spec, no code, no goal interview here. A vague ask makes every later stage work
harder; this skill does a brief scan and hands back a precise, portable prompt.

## Boundary

- This skill sharpens the **prompt** — what to ask, which terms to pin, what context
  is missing.
- It does **not** interview for the goal and it does **not** author a spec or write
  code. Those happen in the fresh session this skill hands off to.

## How to run

1. Do a **fast** context scan only — no spec, no code, no full investigation. Read
   `~/repos/Wiki/index.md`, use CodeGraph if the repo is indexed, and open the obvious
   files the prompt names.
2. Identify what makes the prompt weak: ambiguous terms, missing context, unstated
   scope, undefined success criteria, unverified assumptions baked into the wording.
3. Propose a **reformulated prompt** back — tighter, gaps filled or flagged as open
   questions. Keep it short.
4. Wait for the user to confirm or adjust the reformulated prompt before advancing.
5. Once confirmed, emit the final deliverable as a **verbatim, fenced prompt block**,
   ready to paste into a brand-new session. It must contain:
   - The confirmed, sharpened prompt.
   - Any load-bearing context surfaced during the scan (files, constraints, terms
     pinned) that the new session would otherwise have to rediscover.
6. Do not continue the task yourself in this session unless the user explicitly asks
   to continue here instead of pasting elsewhere — the point of the block is
   portability to a fresh session.

## Verbatim prompt block — format

```
[Context gathered here — files, constraints, pinned terms]

[Confirmed, sharpened prompt]
```

## Anti-patterns

- Turning the fast scan into a full investigation or starting to build.
- Rewriting the prompt silently instead of proposing it back for confirmation.
- Doing goal discovery's job here (interviewing for the goal). Keep it to the prompt.
- Emitting the confirmed prompt as plain prose instead of a copy-pasteable block.

## Handoff

Confirmed, sharpened prompt → packaged as a verbatim, paste-ready block (see format
above) → user pastes it into a new session to continue the work.
