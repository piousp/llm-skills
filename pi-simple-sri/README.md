# pi-simple-sri

A self-improvement loop for [pi](https://pi.dev) skills: it turns feedback into a lesson, tests the lesson
against the skill it would change, and records every decision.

[![npm version](https://badge.fury.io/js/pi-simple-sri.svg)](https://badge.fury.io/js/pi-simple-sri)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

SRI stands for self-recursive improvement: the loop improves the procedure that produces its own
improvements.

The unit of change is a lesson, a short procedural note stored as a file inside the skill. A lesson
records what a failure taught, so the next run of that skill does not repeat it. The loop writes a
lesson only after a gate replays the work twice, against the skill as it stands and against the skill
with the lesson, and only when every replay with the lesson passes while at least one without it
fails. Every step of that decision is recorded on disk.

## Install

```bash
pi install npm:pi-simple-sri
```

You need pi 1.4 or newer and node 22.19.0 or newer. The gate starts `pi` as a child process, so the
`pi` binary has to be on `PATH`.

## What it does

The loop takes feedback from two sources.

1. The failures of the current session: a tool call that came back with an error, a correction you
   wrote after an error, or the same tool running three or more times with the same arguments.
2. A case bank, a JSON file you write that declares the questions a skill has to answer and what a
   good answer contains. This source needs no failure in the session.

From either source the loop drafts one lesson, stages it with a decision record, and gates it. On a
pass the lesson is written into the skill and the session reloads. On a rejection or an abstention
the skill is untouched and the candidate stays in staging, as the record of what was tried.

## First use

Start in a session that already has a failure in it. The loop reads the current branch of the
session, so a fresh session has nothing to improve.

1. Something breaks. For example, ask for a file that is not there:
   `read /tmp/report.pdf and tell me what page 4 says`.
2. Optionally correct it: `no, the file is in ~/Downloads/report.pdf`.
3. Run `/skill-improve <skill>`, naming the skill involved.

That one command proposes the lesson, gates it, and, if the gate passes, writes it into the skill and
reloads the session in the same run. You can add a hint after the skill name, as in
`/skill-improve <skill> merged cells lose their column order`; the hint travels with the proposal.

A few details about the flags, for when you need them. Each flag is one token with its value after
the equals sign, `--` ends the flags, and everything after it is the hint, so a hint with spaces
arrives whole.

## Improving without a failure

Not every improvement starts from something that broke. A review finding, a rejected draft, a rule
the skill should follow: those are measured by a case bank, and the flags choose the material.

- `/skill-improve <skill> --bank=<path>` proposes a lesson from your ask and measures it against the
  cases of the bank.
- `/skill-improve <skill> --bank=<path> --defect` proposes from a defect an artifact shows. The bank
  names the artifact, where it is, and the entry that does not hold. `--defect` without a bank is a
  usage error.
- `/skill-improve <skill> --staged=<stagingPath>` gates a candidate that is already in staging. This
  is how you retry after a missing bank, without paying for the proposal twice.

A bank is one JSON object whose `format` is `pi-simple-sri/case-bank@1`. It holds two to fifty cases,
each with an `id`, a `prompt`, and at least one check. There are four kinds of check: `contains`,
`not-contains`, `regex` and `not-regex`. The checks read the final answer of the replayed turn and
nothing else, so a case measures what the skill answers, not which tools it used. The full format is
`schemas/case-bank.schema.json`, published inside the package.

A bank may declare a `rubric`, the criterion a judge applies to every case. When it does, the gate
adds a second condition: the mechanics accept first, and then the judge reads the answers against
your rubric, verbatim. The judge is the model of the session, one call per case, capped at 256 tokens
of output. A `FAIL` from the judge rejects the candidate; it can never rescue one the checks refused.

A bank that is missing, unreadable or of another version is answered with `no-baseline`: nothing is
spent, the candidate stays in staging, and `--staged` with the bank in place gates the same candidate
later.

## What to expect

Three outcomes, all of them normal:

- Accepted: the lesson is written into the skill, next to a copy of the skill as it was. The
  acceptance is reported first and the session reloads last, so a reload that fails leaves the
  acceptance standing and the lesson takes effect from the next session start.
- Rejected: the skill is untouched and the candidate stays in staging. A rejection is evidence
  against the lesson, not a defect of the run.
- Abstained: the gate could not decide, so it claims nothing either way.

The rule the gate applies is written into the record before the first run, so it cannot be chosen
with the numbers in hand: the candidate has to pass every one of its runs while the skill it
replaces misses at least one. Each side gets two repetitions per item, over at most three items,
which is four runs against four with two items and six against six with three.

The gate spends tokens. Every run is a whole `pi` session in a child process, so it costs a full
turn, and the worst case is twelve of them. The clock is what is bounded: 180 seconds per run and
twenty minutes for the whole gate. The proposal is one model call of its own, capped at 2048 tokens
of output.

One warning worth reading twice: a replay is not a sandbox. The child runs in the working directory
of the failing turn, with the same tools you have, so a replayed turn that edits or creates files
does exactly that in your tree. Run the gate on a project whose state you can restore.

## The tool the model can call

The model can run parts of the loop through the `skill_improve` tool, which has four actions:
`diagnose` reads the session and the skill and reports what failed, `propose` stages a candidate,
`gate` measures a candidate that is already in staging, and `validate` reads a case bank and reports
its first violation or that the bank is valid. `diagnose` and `validate` cost nothing; `propose`
spends one model call; `gate` spends the replay budget. The tool never accepts: only the command
edits a skill.

## Reports and retirement

Four more forms of the command. The first two read the index and spend nothing.

- `/skill-improve --metrics` reports the numbers of the series: the rate of acceptance, the rate of
  recurrence, the regressions the gate counted, and how many failed runs came from the text and how many
  from a tool that returned an error. If records were pruned, the report says how many it could not read
  instead of measuring a shorter series silently.
- `/skill-improve --verify` checks every accepted lesson still in force against the record that
  accepted it, and against the `SKILL.md` of the skill.
- `/skill-improve <skill> --retire=<slug> --reason=<key> <detail>` takes an accepted lesson back out
  of use. The reason is one of five keys, `stale`, `superseded`, `ineffective`, `wrong` or
  `unreferenced`, and the detail is your own sentence. The run snapshots the skill first, then the
  lesson file stays in place as a tombstone and its reference line leaves `## Lessons`, so pi stops
  loading it.
- `/skill-improve <skill> --signal=<id> --bank=<path>` confirms a suspicion the extension noticed on
  its own. Two things raise one: a call to `write` or `edit` that names a file an earlier turn
  already wrote with different arguments, and a user prompt that repeats an earlier one. The notice
  carries the `id`. A confirmation without a bank spends nothing and leaves the suspicion open.

## Where the files are

Everything the loop writes on its own lives under `<agent dir>/sri/`. pi resolves the agent directory
itself, `~/.pi/agent` by default and `PI_CODING_AGENT_DIR` when set, so an upgrade of the package
never removes a candidate.

- `staging/<timestamp>/<skill>/` holds the candidate: the lesson, `decision.json` with the evidence,
  the diagnosis and the gate result, the two arms of the gate, and the raw output of every run.
- `state/attempts.jsonl` is the audit index, one event per line, append only.
- `state/signals.jsonl` holds the suspicions, one event per line, folded at 128 lines.

An acceptance and a retirement are the only two writes inside a skill: `lessons/<slug>.md`, one
reference line under `## Lessons` in `SKILL.md`, and a snapshot under `.history/<timestamp>/`. A
timestamp that already exists is refused instead of overwritten, so history is never rewritten.

## Eligibility

Skills are eligible by default. To restrict them, set `pi-simple-sri.skills.allow` and
`pi-simple-sri.skills.deny` in `~/.pi/agent/settings.json`. Names are exact, `deny` wins over
`allow`, and an empty or missing `allow` admits every skill. Standalone `.md` skills cannot be
improved, because they have no directory of their own for lessons. The skill named `improving-skills`
that ships with this package is never eligible.

## Limits

- The gate is strict on purpose. The candidate has to pass every one of its runs while the incumbent
  misses at least one, so a rejection or an abstention is as expected as an acceptance.
- Without a bank, the loop needs failures from the current branch of the session, and at least two
  distinct ones. With fewer, the gate abstains with `insufficient-items` before spending a run,
  because one failure compares the skill against itself.
- The judge is not always spent. It runs only when the bank declares a rubric, and only after the
  mechanical checks already accepted the candidate.
- A retirement is not undone. There is no `unretire`; the way back is to propose another lesson and
  let it pass its gate.
- A proposal costs one model call even when the gate later cannot run, for example when the bank is
  missing.

## References

The design follows the 2026 literature on skill self-improvement. These are the works behind the rules a
user sees; the full list of 22, with the rule each one supports, is in [REFERENCES.md](REFERENCES.md).

| Reference | Identifier | What it supports here |
|---|---|---|
| SAGE | [arXiv:2609.36043](https://doi.org/10.48550/arXiv.2609.36043) | A paired per-item test with abstention removes regressions |
| HMED | [arXiv:2610.07979](https://doi.org/10.48550/arXiv.2610.07979) | Compare both arms from the same restored starting state |
| Compile Once, Run Cheap | [arXiv:2610.25114](https://doi.org/10.48550/arXiv.2610.25114) | Preregister the threshold and declare the minimum detectable effect |
| SELM | [arXiv:2610.24630](https://doi.org/10.48550/arXiv.2610.24630) | The validation gate is the component with the largest effect; retirement is part of the loop |
| R² Flow | [arXiv:2609.33867](https://doi.org/10.48550/arXiv.2609.33867) | The acceptance signal is not the signal that guided the proposal |
| Who Verifies the Verifier | [arXiv:2610.11464](https://doi.org/10.48550/arXiv.2610.11464) | A judge with a preregistered rubric keeps the mechanical rule as a necessary condition |
| Indirect injection under skill evolution | [arXiv:2610.39122](https://doi.org/10.48550/arXiv.2610.39122) | Tool output, error excerpts included, travels delimited as data |
| EvoPathBench | [arXiv:2609.24663](https://doi.org/10.48550/arXiv.2609.24663) | Evidence is derived from the session branch and deduplicated by id |

## More

- [CHANGELOG.md](CHANGELOG.md) records what each milestone added.
- [REFERENCES.md](REFERENCES.md) lists every paper, its DOI and the rule it supports.

## License

MIT
