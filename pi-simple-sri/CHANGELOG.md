# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

### Added

- The observer: deferred detection of corrections across sessions, off until `pi-simple-sri.observe.enabled` is
  set. On `session_start` (reasons `startup` and `new`, TUI, top-level session) a background cycle cuts the other
  session files into episodes of one skill run (explicit `/skill:x` or implicit read of its `SKILL.md`), flags them
  with a deterministic prefilter, sends the ones with a correction or a repeated request to an LLM judge within a
  daily budget, and groups the findings into patterns in `state/observe.jsonl`. Secrets are redacted before the judge
  and before the store, files are 0600 and directories 0700.
- A pattern seen in at least two sessions on two UTC days, with decayed weight of 1.6 or more and a posterior
  P(rate > 0.15) of 0.8 or more (not mechanical-only), becomes one proposal at most per 24 hours. The user is asked in
  a dialog (Later, Approve, Reject); the gate runs in the background, a second dialog shows the result, and Accept
  dispatches `/skill-improve --review=<id>` (`pi.sendUserMessage`), which asks again and is the only step that accepts
  and reloads. The dispatch is sent only when the session is idle: otherwise it waits for `agent_settled` and checks
  `isIdle()` again, and if the session is busy then the user gets a notice. During `--scan`, Accept runs the review inline
  in the command and reloads once on an acceptance.
- The lifecycle of a pattern: an accepted lesson closes its pattern (tombstone `accepted`) until a newer observation;
  a lesson refused as `skill-drift`, or staged without `skillContentHash`, is closed with a `stale` tombstone and the pattern
  reopens on a newer observation; "newer" is the session time (the episode's `startedAt`), not the ingest time; only the
  latest proposal of a pattern is live (cycle reuse and `--review`); a retryable gate stages a fresh candidate, twice at
  most per pattern, then offers probation; a proposal that cannot be prepared waits 24 h, 72 h and 7 d after the 1st,
  2nd and 3rd-or-later failure (`prepare-failed` event); `observe.replay.allow` is read again before a bank is promoted
  and before the gate (a skill taken off the list is retryable and then probation).
- Prompt (a) shows the gate runs planned (arms x repetitions x items, at most), not how often the pattern was seen, and
  states that the gate proves the lesson works on the cases, not that the pattern is real; a probation lesson is
  labelled "not measured".
- `--forget` erases the skill's observer events and confirmed signals, the content and gate runs of its candidates that
  were never accepted, the bank copy and gate runs of the accepted ones, the drafts of generated banks, `trigger.focus` and
  `diagnosis.summary` in its `decision.json` files (history records included) and `banks/<skill>.json` when the observer
  generated it; it keeps user and skill-shipped banks, accepted lessons, `attempts.jsonl`, the verdicts and the `forget`
  event, which is written first. A history record it cannot clear is listed in the report (`historySkipped`) and warned,
  not thrown; `recordsCleared` counts the records nulled. A forget that lands while the cycle prepares a proposal stops it and discards what it made
  (`discardSkillArtifacts`: artifacts only, no event rewrite, no lock).
- Prompt (a) counts the observations it does not list as `+N more`, and the pattern line is the shortest summary of at
  least 12 characters (the shortest one there is when none reaches it).
- `src/json-reply.ts`: one reader of a model reply that must hold one JSON object, shared by the proposer, the observer's
  judge, the bank generator and `--setup`.
- `ensurePrivateDir` in `src/writer.ts`: the directories the observer owns are made after the perimeter check.
- Settings `pi-simple-sri.observe.enabled`, `judgeModel`, `limits.judgeCallsPerDay` (default 20) and
  `replay.allow` (default empty: only listed skills are ever replayed with real runs; the rest go on probation).
- Probation: a lesson no gate measured, accepted by the user, recorded with its own status `probation`, counted
  apart in `--metrics` and treated as intact by `--verify`. The decision surface `observer` records proposals from a
  pattern.
- Case banks for the observer: `<agent dir>/sri/banks/<skill>.json`, the legacy `case-bank.json` shipped by a skill
  (read only), and a bank generated from at least two episodes of two sessions in one cwd, approved by the user
  before the gate runs. A bank has an optional `provenance` (`user`, `skill-shipped`, `auto`).
- Flags: `/skill-improve --setup`, `--scan [--dry-run [--limit=<n>]] [--since=YYYY-MM-DD]`, `--review[=<id>]` (the id
  only as `--review=<id>`), `<skill> --note <text>` and `<skill> --forget`. `--limit` is the number of episodes a dry run
  judges and is refused without `--dry-run`. The tool gains the action `record`: it takes `skill` and the note in `focus`
  (at most 300 characters), appends a self-report and never edits a skill, gates or accepts; it answers `observe-disabled`
  when the observer is off.
- `--scan --dry-run` writes nothing to the store, asks before it spends and writes labeling records to
  `<agent dir>/sri/labeling/`; `scripts/score-labels.ts` scores them (precision and recall of the judge, recall of
  the prefilter).
- `schemas/observe-event.schema.json`, and an optional `provenance` in `schemas/case-bank.schema.json`.

### Fixed

- B1: the `<skill>` block is no longer read as what the user typed in the evidence, the replay prompt and the signal
  prompts (`splitSkillBlock`).
- B2: the signal collector keys "same turn" and the signal id on the entry id of the user message and the ordinal of the
  user prompt, not on pi's `turnIndex`, which restarts on every agent run.
- B3: `signals.jsonl` is compacted oldest first, so the reader folds the newest lines, and the compaction keeps the lines
  another session appended since its read, compared by content (a session that compacted first leaves a shorter file).
- A case bank that exists and cannot be read is no longer treated as no bank: `resolveBank` answers `found`, `absent` or
  `unusable`, and a generated bank no longer replaces an unreadable one.
- An unusable bank no longer stops the observer cycle: that pattern is recorded as a failed preparation with the reason
  (`prepare-failed`, 24 h, 72 h, 7 d backoff) and the next pattern is tried.
- A resumed session whose episode grew is read again (the latest `episode` event per id wins); a judge that failed or was
  skipped no longer consumes the episode; episodes of a forgotten skill are skipped before the prefilter and the judge.
- `schemas/observe-event.schema.json`: proposals carry `skillContentHash` (`sha256:<64 hex>`) and the union has
  `prepare-failed`; `schemas/decision.schema.json` and `src/gate/probation.ts` accept a case-bank record that concluded
  `gate-abstained`/`no-improvement` as probation.
- B4 (exclude bank from overlay): a `case-bank.json` shipped inside a skill is no longer copied into the arms of the
  replay.
- The text that promised that the tool registers a correction now says what happens: when
  `pi-simple-sri.observe.enabled` is on, `record` stores the correction as a note for a later review, without editing any
  skill or accepting anything; with the observer off nothing is stored.

### Changed

- `/skill-improve --verify`, `--metrics` and the lesson frontmatter understand `probation`.
- The extension registers a `session_shutdown` handler that aborts the background cycle, and an `agent_settled` handler
  that runs the review dispatch the cycle deferred.
- `ensurePrivateDir` replaces `ensureStateDir` and the `mkdirSync` of the observer's wiring, so the observer no longer
  creates directories outside the writer chokepoint.
- Acceptance of an observer proposal compares the skill with the digest recorded at staging, never one computed at
  accept time.

### Documented

- `--setup` rewrites `settings.json` as 2-space JSON, so other formatting is lost. Implicit attribution reads a session
  in file order, not along the active branch, and is noisy. The spike behind the dispatch of `--review` ran on pi 1.5.2, not
  on the 1.4.0 development dependency.
- `--forget` cannot remove content that carries no `skill` field (an unconfirmed suspicion), and a line appended between
  its last read and the rename is lost. After a stale close, the same lesson proposed again the same day is a failed
  preparation (24 h backoff). The judge budget counts a persistently failing episode once. The dry-run sample is the most
  recent N. `scripts/` is outside `tsconfig`. The gate proves the lesson works on the cases, not that the pattern is real.

## [0.0.2] - 2026-11-06

### Changed

- A `read`, `grep`, `find` or `ls` that the machine refuses to run is no longer replayed as an item a lesson could
  fix: `EACCES` and `permission denied` join the list of failures that are intrinsic to the task (OA7), so a gate
  planned from the session stops counting a permission the skill cannot grant. A `write` the machine refuses stays
  replayable, because a skill can name a path that is allowed.

### Documented

- The judge is a recorded condition and not a source of truth: it can accept a case whose answer does not satisfy
  the rubric, and the unanimity between the cases is what keeps a wrong acceptance out. Said in the README and in
  the manual.
- A bank is replayed in the working directory of the session, so a file of that directory that answers the case
  makes both arms pass and the gate abstains with `no-improvement`. Said in the README and in the manual.

## [0.0.1] - 2026-11-05

### Milestone M1: the paired replay gate and the acceptance

The candidate is no longer the end of the loop -- a lesson is written into the skill only when a replay
says it helps.

#### Added

- Paired replay gate over a staged candidate: two arms copied into staging that
differ only in the `## Lessons` section, two repetitions of each replay item
over at most three items, so `2 x 2 x min(items, 3)` runs and a ceiling of
twelve. Fewer than two eligible items abstains without spending a run.
- Preregistration: the rule, the design and the floor of the design are written
into `decision.json` before the first run, with the moment they were recorded,
so the threshold cannot be chosen with the numbers in hand. The rule is
unanimity of the candidate arm plus strict superiority over the incumbent.
- Abstention as a recorded result: `insufficient-items`, `no-improvement`,
`invalid-run`, `interrupted`, `no-model`, `skill-unavailable`, `overlay-failed`
and `candidate-mismatch`, each with the runs actually spent. The line the index
gains for an abstention carries the reason it stopped and the detail behind it,
so the index answers why nothing was published without opening the record.
- Mechanical expectation per replay item, replacing the prose predicate: which
tool call, or which correction, has to stop failing. A failure intrinsic to the
task is excluded before the items are counted, and the exclusion is recorded.
- Replay executor: one `pi` child per run, in JSON mode, in the working
directory and under the `provider/model` of the failing turn, loading the arm
and the rest of the skills that session had. 180 s per run, 20 minutes per gate,
and the raw output of every run kept under the candidate, truncated at 2 MiB.
A run whose stream passed the cap, and a child that never started, are both
named in the record of that run instead of leaving the gate with an abstention
nobody can explain.
- Acceptance: `.history/<timestamp>/` copy taken before the first edit,
`lessons/<slug>.md` verified against the hash the gate measured, an idempotent
reference line under `## Lessons` in `SKILL.md`, the record of the acceptance
written into the snapshot, and an `accepted` line in the index carrying
`historyPath`. A reference line that cannot be written withdraws the lesson.
- `decision@1`: full `gate` block (basis, status, budget, tokens by arm,
preregistration, replay result), tokens per arm, the Wilson interval and the
count of regressions. A candidate staged under an older schema is refused
instead of migrated.
- `failureSignature` on every line of the index, `null` for an attempt with no
diagnosis to point at, so every attempt on one failure can be grouped without
opening a record.
- `skill_improve {action: "gate"}`: the tool can measure a staged candidate,
report the verdict and the runs it spent, and still never accepts.
- The index vocabulary is a single list with a reserved name for the future; a
reader that meets an event it does not know classifies the line instead of
failing on it.

#### Changed

- `/skill-improve` runs propose, then the gate, then the acceptance: a lesson is
written into the skill in the same command run that proposes it, and only when
the gate accepts. Rejections and abstentions leave the skill untouched and the
candidate in staging.
- The append to `state/attempts.jsonl` is a single `O_APPEND` write of one line,
verified against the tail of the file, instead of a read-modify-write of the
whole index. Two sessions appending at the same moment no longer risk losing a
line, and no lock file is written.
- The write perimeter reaches the skill only through the acceptance: the skill
directory, its `lessons/` and its `.history/` are added as roots, and nothing
else outside the write base became writable.

#### Notes

- Running the gate spends tokens: every run is a whole `pi` session in a child
process, and the worst case is twelve of them plus the one proposal generation.
- A replay is not sandboxed. The child inherits the working directory of the
failing turn and the user's tools, so a replayed turn can write in that tree.
- The session reload after an acceptance is **not** part of this milestone. A
lesson accepted mid-session is on disk and active from the next session; M2 is
the reload.
- Needs pi 1.4 or newer, with the `pi` binary on `PATH` for the gate.

### Milestone M1c: measuring without a failure

Measuring an improvement that has no failure behind it. A case bank -- a JSON
file the user writes -- declares the cases a skill has to answer and what a good
answer contains, and the gate measures the candidate against that file instead
of against a turn of the session. `version` in `package.json` is untouched, and
this section is folded into a release when the milestone is published.

#### Added

- The fourth evidence class, `quality_defect`: evidence read from an artifact
  instead of from a turn of the session, carrying the `origin` of the finding
  (how it was found, the resolved path, the digest of its bytes) and the entry
  that does not hold.
- The case bank, format `pi-simple-sri/case-bank@1`, published as
  `schemas/case-bank.schema.json`: one format read under two profiles chosen by
  the invocation -- `baseline` for a directional improvement, which may declare
  the rubric the judge applies to every case, and `origin` for a defect, which
  requires the artifact and forbids a rubric. The file is read once, its bytes
  are hashed, and it is copied next to the candidate before the first run, so
  the cases and the rubric travel with the attempt.
- The directional gate: the design, the rule, the floor of the design and the
  materials of the bank are preregistered in `decision.json` before the first
  run, and the budget is the paired one -- `2 x 2 x min(cases, 3)` runs, eight
  with two cases and twelve with three or more.
- The judge as the second condition of a gate whose bank declared a rubric: one
  call per case on the first repetition of the candidate arm, the preregistered
  rubric as its only criterion, the answer delimited as data, and the verdict
  read off the first line of the reply. A `FAIL` rejects (`judge-failed`) and a
  reply nobody can read abstains (`judge-unavailable`). The mechanical rule stays
  a necessary condition, so the judge never decides on its own.
- `no-baseline`, the event of a gate that found no bank to measure against. It
  was the one reserved name of the index and is now written: nothing is spent,
  the candidate stays in staging and the record keeps `not-run`.
- `--bank=<path>`, `--defect` and `--staged=<stagingPath>` on `/skill-improve`,
  and `bankPath` and `defect` on the `propose` and `gate` actions of the tool,
  which still never accepts. Each flag is one token and `--` ends them, so a
  focus with spaces still arrives whole.
- A notice at the start of a session naming the ways to give feedback and the
  cost of the gate, silent in a session pi reloaded. The description of the tool
  and the usage line of the command name the same material, so a reader who
  misses one channel meets the other.
- `gate.preregistration.skillContentHash`, neutral to the basis: both gates write
  the digest of the `SKILL.md` they measured and the acceptance reads it there,
  because the result of one basis is `null` in the block of the other.

#### Changed

- `decision@1` grew branches and enums additively: `gate.basis` widened from a
  `const` to an enum, `gate.caseBank` and `gate.preregistration.caseBank` added,
  `threshold.judge` and `tokens.judge` added, `checkFailures` on a run of a bank,
  and the fourth evidence class with its `origin`.
- The usage line of `/skill-improve` offers the eligible skills as one
  comma-separated line of names instead of one line per skill with its
  description. The help answers which name to type, and the description stays in
  the inventory that already carries it; the tool's sentence about an unknown
  name was already the list of names.
- `diagnosis.replayItems.minItems` relaxed from 1 to 0. No record written before
  stops validating, and the guard that refuses an empty diagnosis of the
  transcript became a property of each basis instead of a keyword of the schema.

#### Notes

- A bank is a file the user owns and its checks run on the JavaScript
  regular-expression engine: a pattern with catastrophic backtracking can hang
  the evaluation of a run. The text under judgement is cut at 16 000 code points
  and a pattern at 500 characters, and neither makes that engine safe.
- Without a readable bank there is no directional acceptance. Nothing is spent,
  the candidate stays in staging and the record keeps `not-run`, so the retry is
  the same candidate through `--staged`.
- The gate of a bank needs the model of the session twice, once to replay the
  cases and once to judge the answers; a session with no model is refused
  before the bank is read and no run is spent.
- The reload of the session after an acceptance is still M2.

### Milestone M3: reading the series back

Reading back what the loop recorded. Until this milestone the index of attempts had three writers and no
reader, and the records it names were written and never read; the package reads them now, and three answers
hang from that reading: the numbers of the series, the state of an accepted lesson against the record that
accepted it, and the precondition of a retirement. An accepted lesson can also be taken back with its reason
on file, and the two silent signals of the user are noticed at the end of a turn without spending a token.
`version` in `package.json` is untouched, and this section is folded into a release when the milestone is
published.

#### Added

- The reader of the index: `state/attempts.jsonl` and the `decision.json` each of its lines names, with a type
  wider than the writer's -- an event a later version wrote is kept and counted instead of failing the read --
  a `damaged` position for the first line nothing can interpret, and no write of any kind.
- `--metrics`: the rate of acceptance over the attempts that reached a gate, the rate of recurrence over the
  accepted lessons in force, the regressions the gate counted as a column of support, the two causes a case of
  the fourth class can fail for, and the coverage of the records the index names. The rates are projected from
  the ledger on every call and never stored, and the report decides nothing.
- `--verify`: every accepted lesson still in force, compared with the record that accepted it -- `intact`,
  `frontmatter-moved`, `body-moved`, `missing` or `unreadable` -- plus whether the `SKILL.md` of the skill still
  reaches the file. No branch reads `status` or `gate` of the frontmatter.
- `--retire=<slug> --reason=<key>`: the retirement of an accepted lesson. Its own `.history/<timestamp>/`
  snapshot first, the reference line out of `## Lessons`, the lesson rewritten as `status: "retired"` with the
  body unchanged, `.history/<timestamp>/retirement.json` (`retirement@1`) with the reason, and one `retired`
  line of the index carrying the hashes of the acceptance.
- `retired` in the vocabulary of the index: the event the retirement writes, joined to its `accepted` by
  `candidateHash`. It is an emitted event, never a reserved name.
- The collector of signals at the end of every turn: `rewritten-draft` and `repeated-request`, decided
  mechanically with no model call, no process and no clock. A suspicion survives the session that raised it in
  `state/signals.jsonl` (`signal@1`), append-only, with `raised` and `consumed` events and a ceiling of 128
  lines.
- `--signal=<id>`: the confirmation of a suspicion, which opens the directional attempt that measures it and
  needs a bank; without one nothing is spent and the suspicion stays open.
- Eligibility re-checked before the gate spends and before the acceptance writes: `not-eligible` refuses a
  candidate whose skill the settings no longer admit, and the acceptance takes the verdict as data and refuses
  with `no-longer-eligible` before it snapshots anything.

#### Changed

- The write perimeter reaches the skill through two paths instead of one. A retirement writes there through the
  same chokepoint as the acceptance, and takes its own snapshot before it touches anything.
- A lesson that a retirement took back is inert because its reference line is gone, and its state is recorded
  in the file so a reader of the skill can tell it from a lesson that is in force.

#### Notes

- A retirement is not undone: there is no `unretire`, and the way back is another lesson that passes its gate.
- The rates are only as complete as the records that survive. A pruned `staging/` shortens the series, and the
  report prints how many of the records it names it could not read.
- Recurrence is measured by class of failure -- the kind and the tool -- because the signature a record stores
  carries the timestamp of its own session and two sessions never share one.
- A suspicion is not a defect. The two signals are noticed and reported, and only a confirmation of the user
  turns one into an attempt that can spend.
- The recursive step, where the generator itself is versioned and evaluated, is M4.

### Milestone M3c: technical debt

The five debts the handoff of M3 left behind, closed without a change of behaviour: each one was a rule or a
literal with two owners that only a comment kept in step.

#### Added

- The `LICENSE` file (MIT), which `package.json` already declared.

#### Changed

- The README is rewritten for the people who install the package: what SRI does, how to use it, and what to
  expect. The internal detail stays in `DEVELOPER.md`.
- `decision@1` has one owner: the literal and its type are declared together in `src/types.ts` as
  `DECISION_SCHEMA`, and the reader of the index, the gate and the builder of the record import it instead of
  spelling it again. The tests keep the literal written by hand on purpose, because a test that imported the
  constant would follow a `@2` instead of refusing it.
- The cap of an excerpt has one owner: `MAX_EXCERPT_CODE_POINTS` lives in `src/evidence.ts` beside `textOf`, and
  the collector of signals, the reader of a bank and the summary of a defect cut at the constant they import. The
  two schemas that declare the limit are compared against it by the suite, so the number a user reads in the
  contract cannot drift from the number the reader applies. `src/proposer.ts` keeps its own `textOf`, which reads
  a value of a different shape.
- The force of an accepted lesson has one owner: `src/vitality.ts` declares the event an acceptance writes and the
  two predicates the rule of retirement is made of, and the recurrence of `--metrics` and the check of an accepted
  lesson import them. The reading of "accepted" stays split in two on purpose -- the recurrence needs the record,
  the check needs the event alone -- and the module exports no predicate for the pair.
- The settings of a run are read once: `src/config.ts` owns the name of the file and the reader, `src/eligibility.ts`
  owns the verdict over the spellings of a skill, and one `SriConfig` travels from the branch that runs to the
  proposal, the gate and the acceptance. An edit of `settings.json` in the middle of a gate is seen by the next run
  and not by the one in flight.

#### Fixed

- The reader of the index checks the spine of the record a line names instead of only its version: a record that
  lost `skill.realDir`, a string of `candidate`, `evidence`, `outcome.status` or the pair of `gate` is the
  `problem` of its line, the reading of the next line goes on, and the three consumers answer instead of raising
  where they happen to dereference it. The guard is the fields they read and not the whole of `decision@1`, so a
  block nested deeper and malformed stays the problem of the consumer that reads it.

### Milestone M0: the loop and the audit trail

The first release. It stages lesson candidates and records every decision; it does
not accept a lesson yet, because acceptance needs the paired replay gate that
lands in M1.

#### Added

- `/skill-improve <skill> [focus]` and the `skill_improve` tool with `diagnose`
  and `propose` actions. `diagnose` reads only; neither surface accepts a
  lesson.
- Evidence derived from the current session branch: tool errors, user
  corrections and retry loops, with deterministic ids and a canonical hash of
  the arguments.
- Typed diagnosis with a failure signature and the replay items the gate will
  use.
- One-shot proposal through the session model: the skill text and the evidence
  travel in delimited data blocks, markers are escaped, and the reply is parsed
  as the first valid JSON object.
- Staged candidate layout under the write base `<agent dir>/sri`:
  `staging/<ts>/<skill>/lessons/<slug>.md` plus `decision.json`, validated
  against `schemas/decision.schema.json`.
- Append-only audit index at `<agent dir>/sri/state/attempts.jsonl` with
  `proposed`, `no-evidence`, `not-eligible` and `no-model` events, and a
  `skill-improvement` session entry visible in `/tree`.
- Eligibility through `"pi-simple-sri".skills.allow/deny` in the agent
  settings, with exact names, `deny` winning and both skill names checked.
- Write chokepoint: perimeter check with resolved paths, atomic writes, read-back
  verification, in-process serialization, and symlinked targets written through
  the link.
- Compensation: when the audit index cannot be written, the staged candidate is
  removed and the error names both paths.

#### Fixed

Before publication, so these never reached a release: the single model call
sends the session identifier, because a session-affine provider (opencode-go)
answered `400 MissingSessionID` to every proposal and the run reported it as an
opaque `stopped with "error"`; a refusal reports the provider message, so a
routing or authentication error names itself; and candidates, the audit index
and the records live under `<agent dir>/sri` instead of the package root, which
under `pi install npm:pi-simple-sri` is inside `node_modules` and lost both on
upgrade. The answers print the absolute candidate path, the records keep it
relative, and state staged elsewhere is not migrated.

#### Notes

- Needs pi 1.4 or newer.
- Scope is gated iterative self-improvement. The recursive step, where the
  generator itself is versioned and evaluated, is not implemented.
