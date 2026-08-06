---
name: thesis-planning
description: >
  Staged planning process for a thesis or academic research document — from
  exploratory reading through a research question, a thematic literature map,
  a working table of contents, per-chapter drafting, and reverse-outline
  verification. Use when the user is planning or advancing a thesis,
  dissertation, or research monograph. Do NOT use for fiction, business
  reports, short papers, or single-article writing — those need a different
  planning shape.
---

# Thesis Planning

This skill implements a working literature map, a revisable working table of contents,
a two-layer chapter drafting process (skeleton → full draft, closing the
"progressive expansion" gap a first dogfooding pass found), a reviewer/tutor
feedback loop with lightweight versioning (short of git, by design), and
reverse-outline verification. It does **not** implement a permanent-note/
idea-synthesis layer (a note that turns a source into your own argument independent
of any one chapter); the skeleton layer covers some of that need per-chapter,
but not a cross-chapter note network.

## Critical

- **[NEVER] assume the whole thesis gets drafted in one pass.** Phase 4 operates on
  one chapter at a time, named explicitly by the user.
- **[NEVER] treat `outline.md` as frozen.** It is Eco's "working hypothesis" — it is
  expected to change as chapters get drafted.
- **[NEVER] search or read sources directly in Phase 1a or Phase 2's gap-filling.**
  Delegate to `web-scout`. Recon is mechanical and delegable.
- **[NEVER] select among candidate research questions or outlines on the user's
  behalf.** Selection at a gate belongs to the user, always.
- **[NEVER] adjudicate reviewer/tutor feedback via a subagent.** Deciding whether
  a comment is addressed, rejected, or still open is the user's call.
- **[NEVER] snapshot a chapter version except when triggered by real external
  feedback** (a tutor/professor comment) — snapshotting on every internal edit
  produces noise, not history.
- **[NEVER] let a chapter file declare its own status.** `outline.md` is the sole
  status registry — a footer or header in `chapters/<slug>.md` claiming a status
  is a second source of truth waiting to drift from the first.
- **[NEVER] generate candidate framings (questions, outlines, chapter skeletons)
  yourself** when a subagent can propose them — proposal generation is delegable,
  just like recon and drafting.
- **The user MUST understand what phase is active and why** — confirm before moving
  a phase forward, especially before closing Phase 1's gate.

## Delegation

The governing line: **retrieval, proposal generation, drafting, and read-only
critique are delegable. Selection at gates, feedback adjudication, and final
approval are not.** The coordinator owns every write to `$THESIS_DIR` and never
selects or adjudicates on the user's behalf.

| Phase | Delegate to | Why |
|---|---|---|
| 1a (recon) | `web-scout` + `Lens: skills/thesis-planning/lens/literature-scout-lens.md` (by path, named in the invocation prompt), 2–4 parallel tasks (one per research axis, always incl. feasibility, max 5 sources each) | Mechanical, parallelizable, context-free. Lens mode overrides `web-scout`'s default "no metadata, 1 read" behavior with the bibliography schema + one-read-per-reported-source rule; the agent's own 10-call abort ceiling and no-fabrication invariant still apply |
| 1a (validation) | `scripts/validate_sources.py`, coordinator runs it, never a subagent | Deterministic; rejects malformed records, quarantines unverified ones, before anything is persisted |
| 1b (research question) | `planner` proposes 2–4 candidate framings from `sources-initial.md` (read-only); **user selects**; coordinator persists | Proposal generation is delegable; selection isn't |
| 1b (optional) | `critical-thinker` stress-tests the *selected* question before the gate closes | Adversarial pressure on a decision already made, not a substitute for making it |
| 2 (gap-filling sources) | Same `literature-scout-lens.md` delegation + validation as 1a | Same as 1a |
| 2 (thematic clustering) | `analyst` first-pass proposal is advisory input; **user + coordinator confirm** the map | Clustering is interpretive; proposing it is delegable, finalizing it isn't |
| 3 (outline) | `planner` proposes candidate outlines/decompositions; **user selects**; coordinator persists | Same pattern as 1b |
| 4a (chapter skeleton) | `worker` + `lens/chapter-drafting-lens.md` (skeleton mode, by path); writes `chapters/<slug>.skeleton.md` directly — one file, nothing else | Proposal generation is delegable, same as 1b/3 |
| 4a (gate) | **User confirms/edits the skeleton** before full drafting starts | Selection at a gate is never delegated |
| 4b (full chapter draft) | `worker` + `lens/chapter-drafting-lens.md` (full-draft mode, by path); reads the confirmed skeleton + `outline.md` + `literature-map.md` + `sources.json`; writes `chapters/<slug>.md` directly | Drafting is delegable — see rationale above. Contradictions with `research-question.md` are flagged for the user, never silently resolved by the drafter |
| 4c (feedback logging) | Coordinator persists reviewer comments verbatim into `chapters/<slug>.feedback.md` or `feedback-general.md` | Mechanical transcription, not judgment |
| 4c (adjudication) | **Not delegated** — coordinator + user mark each entry `addressed`/`rejected` (with reason) | The user's judgment on whether their own response satisfies the reviewer |
| 5 (reverse outline) | `analyst`, read-only | An agent that didn't write the chapter is better at spotting drift from stated intent |

No `stages/*.md` files, unlike `iterative-design`: delegation here is a single agent
per phase with a one-paragraph task, not a differently-lensed role that needs a
persistent lens file to carry doctrine across invocations.

## The phase graph is not linear

Unlike a strictly sequential pipeline, this process has expected back-edges:

- **3→1**: the literature map or a chapter draft exposes that the research question
  is wrong or too broad. Going back to refine it is normal, not a failure.
- **4→3**: drafting a chapter exposes that the outline needs to change (add/split/
  reorder a chapter). This is the *common* case, not the exception.
- **4→2**: drafting a chapter exposes a source gap the literature map doesn't cover.

Treat these as expected loops the skill should support, not deviations to avoid.

## Phase 0 — resolve `$THESIS_DIR`

Look for an existing artifact directory (`thesis-design/`, `.thesis/`, or any
directory already containing `research-question.md`) in or above `cwd`. If found,
use it. If not found, ask the user for the thesis project's root directory and
create `<root>/thesis-design/`. Never guess between two candidates if more than one
exists — ask. Resolve once, reuse for the rest of the session.

Artifacts live inside the thesis project directory, not `/tmp` — unlike code
design docs, these are the user's actual long-lived work product (spans months,
must survive reboots).

## Phase 1a — delegated recon

- Delegate to `web-scout`: 2–4 parallel tasks, each covering one research axis (e.g.
  domain literature, local/regulatory context). Never search or read sources
  directly.
- **Always include a data/legal feasibility axis** (found missing in initial
  dogfooding): is the data the question needs actually accessible, and under what
  legal/access constraints? Skipping this axis produces a question that looks
  answerable on paper but isn't once Phase 1b tries to scope it.
- Invoke `web-scout` with the lens named by path in the task prompt (`Lens:
  skills/thesis-planning/lens/literature-scout-lens.md`) — the lens carries the
  structured-output schema (`url`, `doi`, `title`, `authors`, `abstract`,
  `keywords`, `relevance`, `relevance_reason`, `verified_by_read`) and the
  one-`web_read`-per-source rule. No `tools:` override needed — `web-scout`
  already ships `read` for lens mode.
- Coordinator runs `scripts/validate_sources.py` on the returned JSON before
  persisting anything. Malformed records are rejected; records with
  `verified_by_read: false` are quarantined, never silently kept as verified.
- `$THESIS_DIR/sources.json` is the machine-readable source of truth;
  `sources-initial.md` is generated from it for human reading — don't
  hand-maintain both, they drift.

## Phase 1b — research question (not delegated)

- From Phase 1a's output, coordinator + user formulate `research-question.md`: the
  specific question the thesis answers, why it's a gap, and why it's answerable
  with available sources.
- Offer 2–3 concrete phrasings at different scopes — let the user pick or steer.
  Never pick for them.
- **Gate**: the user confirms the question is answerable and scoped before Phase 2
  starts. Do not proceed on an implicit or partial confirmation.

## Phase 2 — literature map (thematic, not chronological)

- Gap-filling searches delegate to `web-scout`, same as Phase 1a.
- Build `literature-map.md`: sources grouped by **theme/position**, not by date or
  author. Each cluster states the shared claim/approach and which sources belong
  to it. Clustering is coordinator + user; an `analyst` pass may propose a draft
  clustering, but it is advisory input, never the map itself.
- Mark where the research question fits relative to the clusters (the gap it fills).
- If this phase reveals the question from Phase 1 doesn't hold up, go back to
  Phase 1 — record the revision in the research question file, don't discard the
  history silently.

## Phase 3 — working table of contents

- Delegate to `planner` (read-only): from `research-question.md` and
  `literature-map.md`, propose 2–4 candidate chapter decompositions. Never the
  coordinator generating these itself — same rule as Phase 1b.
- **User selects** among the candidates, or steers a variant. Never the
  coordinator picking on the user's behalf.
- Coordinator persists the selection as `outline.md`: a provisional chapter list
  with a one-paragraph statement of what each chapter argues or covers. Include a
  **status per chapter**: `pending` / `drafting` / `drafted` / `revised`.
- Explicitly mark this as revisable. It is a working hypothesis about structure,
  not a commitment.

## Phase 4a — chapter skeleton (delegated, gated)

- **Never implicit "next chapter."** Ask the user which chapter to draft.
  Chapters can be drafted out of order — drafting one must never require another
  chapter to already exist.
- Delegate to `worker` + `lens/chapter-drafting-lens.md` (skeleton mode, named by
  path in the prompt): from the chapter's paragraph in `outline.md` and the
  relevant `literature-map.md` cluster(s), propose a one-line-per-subsection
  skeleton. The agent writes `chapters/<slug>.skeleton.md` directly — exactly
  that one file, nothing else.
- **Gate**: the user confirms or edits the skeleton before Phase 4b starts. This
  is the layer Snowflake and Ahrens both use to bridge "one paragraph of intent"
  to "full prose" — dogfooding found it missing when this skill first shipped
  without it.
- Set `outline.md`'s status to `drafting` once the skeleton is confirmed.

## Phase 4b — full chapter draft (delegated)

- Delegate to `worker` + `lens/chapter-drafting-lens.md` (full-draft mode, named
  by path): reads the confirmed skeleton, `outline.md`'s paragraph,
  `literature-map.md`'s relevant cluster(s), and `sources.json`. Argument-first,
  not source-paraphrase — a cluster's "shared claim" is raw material for the
  chapter's own argument, not text to restate. Never cite a URL absent from
  `sources.json`. The agent writes `chapters/<slug>.md` directly — exactly that
  one file, nothing else; the coordinator verifies the file exists before
  flipping status.
- If the draft surfaces a contradiction with `research-question.md`, the drafter
  flags it in the file (a visible note) rather than silently resolving it — that
  is a back-edge signal for the user, not the drafter's call.
- Update `outline.md`'s status to `drafted` once the file exists and the
  coordinator has verified it.
- If drafting exposes an outline problem, go back to Phase 3. If it exposes a
  source gap, go back to Phase 2.

## Phase 4c — review and revision cycle (not delegated)

This is where Silvia's "separate drafting from editing" actually lives — and
where reviewer/tutor feedback gets a durable, traceable home.

- **Feedback logs**: chapter-specific comments go in `chapters/<slug>.feedback.md`
  (append-only); comments that aren't scoped to one chapter go in
  `$THESIS_DIR/feedback-general.md` (also append-only). Never rewrite or delete
  an entry — only append new ones or edit an entry's own `Resolution:` line.
- **Entry format** (a parsed contract — `scripts/state.py` reads the status
  field, so don't drift from this shape):

  ```
  ## <date> | <reviewer> | <version, e.g. v01> | <open|addressed|rejected>
  Scope: <section, or "general">
  Comment: <verbatim, the reviewer's own words>
  Resolution: <empty while open; required one-line reason if rejected>
  ```

- **Adjudication is never delegated.** The coordinator transcribes a comment
  verbatim (mechanical), but marking it `addressed` or `rejected` — and writing
  `Resolution:` — is the user's judgment call, always.
- **Snapshot only when a revision pass is triggered by real external feedback**
  (a tutor/professor comment) — never on routine internal edits. Snapshot the
  chapter as it stood *before* addressing the feedback, into
  `chapters/history/<slug>.vNN.md` (zero-padded). The snapshot must be taken
  before revising starts, so it is exactly the text the reviewer commented on.
- **Comparing versions**: `diff chapters/history/<slug>.v01.md chapters/<slug>.md`
  — no dedicated diff tool. This is the closest thing to "version control" this
  skill provides, deliberately short of git.
- `outline.md`'s status moves to `revised` only when **both**: at least one
  snapshot exists under `chapters/history/` for that chapter, and zero `open`
  entries remain in its feedback log. Both conditions are mechanically checkable
  (see Control script) — this is the first mechanical definition `revised` has
  ever had in this skill.
- Back-edges 4c→3 and 4c→2 apply here too: tutor feedback is a common trigger for
  "the outline needs to change" or "the literature map is missing something,"
  not just Phase 4b's own drafting.

## Phase 5 — reverse-outline verification (optional, gated)

- Delegate to `analyst`, read-only: summarize each section in one sentence and
  compare against the original intent in `outline.md`. An agent that didn't write
  the chapter is better positioned to spot drift from stated intent.
- Surfaces pacing gaps, redundant sections, or claims that drifted from the
  chapter's stated argument.
- **Gate**: ask the user whether to run Phase 5 for a given chapter, or consider it
  finished. Optional means user-gated, not assumed.

## Control script

Run `python3 <skill-dir>/scripts/state.py --dir $THESIS_DIR` to check which
artifacts exist and what chapters remain, instead of re-deriving it from context.
It is read-only and advisory — it never writes, never prompts, never picks a phase
for you. It has no git dependency (unlike `iterative-design`'s `state.py`): thesis
state is artifact existence and chapter status, not commit history.

## Anti-patterns

- The coordinator doing Phase 1a's or Phase 2's reading/searching itself instead
  of delegating to `web-scout`.
- Delegating the selection among candidates, or a chapter's final prose.
- The coordinator generating candidate questions or outlines itself instead of
  delegating proposal generation to `planner`.
- Treating a delegated `analyst` clustering proposal as the literature map itself,
  rather than a draft the coordinator and user still confirm.
- Drafting a chapter before `research-question.md` is confirmed — the gate exists
  because chapters written against an unclear question get rewritten wholesale.
- Treating `outline.md` as frozen once written, instead of a working hypothesis
  that chapters are expected to revise.
- Drafting and editing a chapter in the same pass instead of two distinct passes.
- Skipping Phase 4a's skeleton gate and delegating straight to a full draft — the
  gate is where the user's judgment enters before prose is generated, not after.
- A chapter file (`chapters/<slug>.md`) declaring its own status — `outline.md` is
  the only status registry.
- Snapshotting a chapter version on a routine internal edit instead of only when
  real external (tutor/reviewer) feedback triggers a revision pass.
- Adjudicating (marking `addressed`/`rejected`) a reviewer comment via a
  subagent instead of the user's own judgment.
- Setting `outline.md`'s status to `revised` without at least one snapshot in
  `chapters/history/` and zero `open` feedback entries — `revised` needs both
  conditions met, not just an editing pass having happened.
- Summarizing the literature review chronologically instead of thematically —
  loses the "gap this thesis fills" argument.
- Trying to draft the entire thesis in one Phase 4 pass instead of one chapter at
  a time, tracked independently.
- Silently discarding a superseded research question instead of recording the
  revision when a 3→1 or 4→1 back-edge fires.
