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

1. Do a **fast** context scan only — no spec, no code, no full investigation. Read any
   project-level index or knowledge base the repo maintains, use a code-navigation/indexing
   tool if the repo has one set up, and open the obvious files the prompt names.
2. Identify what makes the prompt weak: ambiguous terms, missing context, unstated
   scope, undefined success criteria, unverified assumptions baked into the wording.
3. Propose a **reformulated prompt** back — tighter, gaps filled or flagged as open
   questions. Keep it short. If the original was already sharp, say so and propose it
   back near-verbatim — it still gets one confirm pass. This proposal is always plain
   prose/quoted text — never the fenced verbatim block; that format is reserved for
   step 5's confirmed deliverable.
4. Wait for the user to confirm or adjust. If they adjust, fold the adjustment in and
   re-propose the updated version — loop back to step 3, repeating until they confirm.
   Never skip straight to the final block after an adjustment.
5. Once explicitly confirmed, emit the final deliverable as a **verbatim, fenced prompt
   block**, ready to paste into a brand-new session. It must contain:
   - The confirmed, sharpened prompt.
   - Any load-bearing context surfaced during the scan (files, constraints, terms
     pinned) that the new session would otherwise have to rediscover.
6. Do not continue the task yourself in this session unless the user explicitly asks
   to continue here instead of pasting elsewhere — the point of the block is
   portability to a fresh session.

## Ask vs. assume

- Ask directly — one targeted question at a time, via the ask_user_question tool if
  available, plain chat otherwise — when the ambiguity is scope-changing: it changes
  what gets built, which system/files are touched, or what success means.
- Assume and flag when the ambiguity is low-impact (naming, format, defaults,
  ordering): resolve it yourself and mark it as an explicit assumption in both the
  proposed reformulation and the final block's context lines.
- Guard: a few targeted questions at most. A full decision-tree interview is goal
  discovery's job (see iterative-design), not this skill's.

## Verbatim prompt block — format

```
[Context gathered here — files, constraints, pinned terms]

[Confirmed, sharpened prompt]
```

## Example

Input: "add retries to the sync job, it keeps failing"

Proposed reformulation: "Which sync job — `nightly_sync.py` or the `sync-worker`
service? Assuming default retry count of 3 with exponential backoff unless you say
otherwise." User confirms.

Final block:

```
File: nightly_sync.py (found in scan)
Term pinned: "sync job" = nightly_sync.py, not sync-worker service
Assumption: retry count = 3, exponential backoff

Add retry logic to nightly_sync.py: retry up to 3 times with exponential backoff
on failure, logging each attempt.
```

## Anti-patterns

- Turning the fast scan into a full investigation or starting to build.
- Rewriting the prompt silently instead of proposing it back for confirmation.
- Doing goal discovery's job here (interviewing for the goal). Keep it to the prompt.
- Emitting the confirmed prompt as plain prose instead of a copy-pasteable block.
- Formatting an intermediate proposal (pre-confirmation) as the fenced verbatim
  block — that format is reserved for the confirmed final deliverable only.
- Emitting the final block right after an adjustment, without re-proposing the
  updated version first.

## Handoff

Confirmed, sharpened prompt → packaged as a verbatim, paste-ready block (see format
above) → user pastes it into a new session to continue the work.
