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
and `candidate-mismatch`, each with the runs actually spent.
- Mechanical expectation per replay item, replacing the prose predicate: which
tool call, or which correction, has to stop failing. A failure intrinsic to the
task is excluded before the items are counted, and the exclusion is recorded.
- Replay executor: one `pi` child per run, in JSON mode, in the working
directory and under the `provider/model` of the failing turn, loading the arm
and the rest of the skills that session had. 180 s per run, 20 minutes per gate,
and the raw output of every run kept under the candidate, truncated at 2 MiB.
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
