# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

### Fixed

- The single model call now passes the session identifier. A session-affine provider
  (opencode-go) answered `400 MissingSessionID` to every proposal, and the run reported it as an
  opaque `stopped with "error"`.
- A refusal reports the provider message when the request failed, so a routing or authentication
  error names itself instead of being indistinguishable from a truncated answer.
- Candidates, the audit index and both answers live under `<agent dir>/sri` instead of the package
  root. With `pi install npm:pi-simple-sri` the package root is inside `node_modules`, so an upgrade
  took staging and state away. Records name paths relative to that base, and the answers print the
  absolute one. State staged before this release is not migrated and stays where it was.

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
- Staged candidate layout: `staging/<ts>/<skill>/lessons/<slug>.md` plus
  `decision.json`, validated against `schemas/decision.schema.json`.
- Append-only audit index at `state/attempts.jsonl` with `proposed`,
  `no-evidence`, `not-eligible` and `no-model` events, and a `skill-improvement`
  session entry visible in `/tree`.
- Eligibility through `"pi-simple-sri".skills.allow/deny` in the agent
  settings, with exact names, `deny` winning and both skill names checked.
- Write chokepoint: perimeter check with resolved paths, atomic writes, read-back
  verification, in-process serialization, and symlinked targets written through
  the link.
- Compensation: when the audit index cannot be written, the staged candidate is
  removed and the error names both paths.

### Notes

- Needs pi 1.4 or newer.
- Scope is gated iterative self-improvement. The recursive step, where the
  generator itself is versioned and evaluated, is not implemented.
