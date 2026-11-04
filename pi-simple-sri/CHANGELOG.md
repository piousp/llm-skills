# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

Milestone M1: the paired replay gate and the acceptance. The candidate is no
longer the end of the loop -- a lesson is written into the skill only when a
replay says it helps. `version` in `package.json` is untouched, and this section
is folded into a release when the milestone is published.

### Added

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

### Changed

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

### Notes

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

## [0.0.1] - 2026-11-03

First release. It stages lesson candidates and records every decision; it does
not accept a lesson yet, because acceptance needs the paired replay gate that
lands in M1.

### Added

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

### Fixed

Before publication, so these never reached a release: the single model call
sends the session identifier, because a session-affine provider (opencode-go)
answered `400 MissingSessionID` to every proposal and the run reported it as an
opaque `stopped with "error"`; a refusal reports the provider message, so a
routing or authentication error names itself; and candidates, the audit index
and the records live under `<agent dir>/sri` instead of the package root, which
under `pi install npm:pi-simple-sri` is inside `node_modules` and lost both on
upgrade. The answers print the absolute candidate path, the records keep it
relative, and state staged elsewhere is not migrated.

### Notes

- Needs pi 1.4 or newer.
- Scope is gated iterative self-improvement. The recursive step, where the
  generator itself is versioned and evaluated, is not implemented.
