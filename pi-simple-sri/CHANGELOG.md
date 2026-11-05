# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog, and this project uses semantic versioning.

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
