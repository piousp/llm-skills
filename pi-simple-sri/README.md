# pi-simple-sri

A self-improvement loop for pi skills, with the audit trail built first.

Self-recursive improvement, SRI for short, names a system that improves the procedure producing its
own improvements instead of only improving outputs. In this package the artifact is text: a `SKILL.md`
and the lessons stored beside it. A lesson is a short procedural note recording what a failure
taught, so the next run of that skill does not repeat it.

This release implements the gated half of the loop. It collects a failure, drafts a lesson, stages it
with a decision record, and then decides whether the lesson earns its place: the failure is replayed
against the skill as it stands and against the skill plus the lesson, and only a unanimous improvement
is written into the skill. Acceptance follows the gate without a confirmation prompt, because running
the command is the consent; a rejection is an ordinary outcome, and an abstention is the expected one
when the design cannot tell the two arms apart.

Two things are explicitly not in this release. The session reload after an acceptance is not here:
a lesson accepted mid-session is on disk and takes effect from the next session. And the recursive
step, where the generator itself is versioned and evaluated, is not built; retirement by merit and the
metrics of a longer loop are later milestones too.

The design follows the 2026 literature on skill self-improvement. [REFERENCES.md](REFERENCES.md)
lists the papers behind each rule, with their identifiers and what each one supports.

## Install

```bash
pi install npm:pi-simple-sri
```

Needs pi 1.4 or newer. The gate starts `pi` as a child process, so the binary has to be on `PATH`.
To load the working copy instead:

```bash
cd pi-simple-sri && pi -e .
```

## Use it

Start in a session that already has a failure in it. The loop reads the current branch of the
session, so a fresh session has nothing to improve.

1. Something breaks. For example, ask for a file that is not there:
   `read /tmp/report.pdf and tell me what page 4 says`.
2. Optionally correct it: `no, the file is in ~/Downloads/report.pdf`.
3. Ask for a lesson for the skill involved:

```
/skill-improve <skill>
```

The command drafts one lesson, stages it, and goes on to gate it. When the gate accepts, the lesson is
written into the skill in that same run and the answer names the history snapshot taken before the
edit; when the gate rejects or abstains, the skill is left untouched and the candidate stays in
staging as the record of what was tried. One command, from the failure to the accept or reject
decision, and the skill is never touched by anything else.

A hint after the skill name lands in the decision record:

```
/skill-improve <skill> merged cells lose their column order
```

The model can run the same pipeline through a tool. `diagnose` reads only, `propose` stages the
candidate, and `gate` measures a candidate that is already in staging. The tool never accepts: a skill
is edited by the command alone.

```
skill_improve {action: "diagnose", skill: "<skill>"}
skill_improve {action: "propose", skill: "<skill>", focus: "merged cells"}
skill_improve {action: "gate", skill: "<skill>", stagingPath: "<the staging path of the candidate>"}
```

## What the gate does

The gate answers one question: does the lesson make the failing turn succeed, reliably enough that it
is worth changing the skill for? It answers it by replaying the failure under two conditions. In plain
language:

- **Two paired arms.** The skill is copied twice into staging and the failure is replayed against both
  copies. The two copies differ in one place only: the `## Lessons` section. The incumbent arm is the
  skill as it stands; the candidate arm is the skill plus the new lesson and its reference line.
  Everything else -- the rest of `SKILL.md`, the other lessons, the files of the skill -- is identical,
  so a difference between the arms is about the lesson.
- **A fixed budget.** Each arm gets two repetitions of each replay item, over at most three items, so
  the budget is `2 x 2 x min(items, 3)` runs: eight with two items, twelve with three. With fewer than
  two eligible items the gate abstains without spending a run. Items are used in the order the evidence
  gave them, and a failure intrinsic to the task -- the read of a file that is not there, which would
  fail the same way whatever the skill says -- is excluded before the items are counted, and the
  exclusion is recorded.
- **A preregistered threshold.** The rule the gate will be judged by is written into `decision.json`
  before the first run, together with the moment it was recorded, so the rule cannot be chosen with the
  numbers in hand. The rule is unanimity plus strict superiority over that sample: the candidate arm has
  to pass every one of its runs and the incumbent arm has to miss at least one. A candidate that misses
  a single run is rejected; a candidate that matches a perfect incumbent is not evidence of anything.
- **Abstention as a result.** The plan is also preregistered as a floor: with six runs per arm the
  smallest difference the design can resolve is one run, one sixth, while the rule asks for a
  difference of one whole pass rate. When the two arms come out identical, or when a run proves nothing
  about the skill, the gate abstains instead of claiming a result. The recorded interval is descriptive
  and never decides.
- **Verdicts that fail closed.** A run that broke -- a kill, a timeout, a non-zero exit, a stream nobody
  can read, a missing working directory, or a skill that did not load -- abstains the whole gate,
  because the broken arm is the baseline the other arm is compared against. A tool result marked as an
  error is a failure of that run and not a discard: the incumbent is supposed to reproduce its own
  failure.

The gate accepts a candidate, rejects it, or abstains. Rejected and abstained candidates both leave the
skill untouched; what separates them is that a rejection is evidence against the lesson and an
abstention is the absence of evidence either way. On an acceptance the lesson is written into the
skill, next to a copy of the skill as it was, and the record of the write is kept beside that copy.

**The reload of the session is not in this version.** After an acceptance the lesson is on disk and the
`SKILL.md` references it, but the session that accepted it keeps the skill it loaded at start: the new
lesson is active from the next session. Reloading the session in place is M2 and is not implemented.

### What running the gate costs

Running the gate spends tokens, and the record keeps the count.

- Every run is a whole `pi` session in a child process, so it spends the tokens of a full turn and not
  of a single call. The worst case is twelve of them: three items, two repetitions, two arms.
- The number of runs is bounded, the tokens of a run are not: each replay is as long as the turn it
  replays takes. The wall clock is bounded instead -- 180 s per run and twenty minutes for the whole
  gate, and a gate that hits either says it was interrupted.
- The proposal adds one model call on top, capped at 2048 tokens of output.
- Every run keeps its raw output under the candidate, truncated at 2 MiB per run, so the verdict can be
  audited without re-running anything.

**A replay is a real session and it can write to the project.** The child inherits the working directory
the failing turn was answered in and the same tools the user has, so a replayed turn that edits, moves
or creates files does exactly that in that directory. Replay is measurement inside the user's own
working tree, not a sandbox: run the gate on a project whose state can be restored, or in a copy of it,
and expect the working tree to look as it did after a failed turn.

## What counts as a failure

| Signal | When it is recorded |
|---|---|
| Tool error | A tool result comes back with `isError` |
| User correction | The user replies after a tool error, before another tool result |
| Retry loop | The same tool runs three or more times with the same arguments, successful or not |

Each signal becomes an evidence item with a deterministic id, a hash of its canonical arguments and
the assistant cycle it belongs to. Repeated evidence is deduplicated by that id.

A diagnosis needs at least one replayable item: one with the user prompt that led to it and the
mechanical expectation the gate can execute -- which tool call, or which correction, has to stop
failing. An item without a prompt, or a tool failure without a tool name, is not replayable and does
not displace one that is. Each replay item also carries the model that produced the failing turn, as
`provider/model`, because a replay under another model is not the same failure.

## The loop

1. Read `settings.json` and the skill inventory. A skill is eligible unless the configuration says
   otherwise.
2. Derive the evidence from the current branch.
3. Diagnose: failure signature, replay items, expectations.
4. Draft the lesson with one model call. The skill text and the evidence travel in delimited blocks
   marked as data, and the prompt says that tool output is not instructions. Markers are escaped so
   a value cannot close its own block.
5. Validate the draft with the same rules used to read it back. An empty body, a bad date or a body
   over 8192 bytes is rejected before anything is written.
6. Write the candidate under the write base, append a line to the audit index, and record a
   session entry.
7. Preregister: check the lesson on disk against the hashes the record declares, compute the plan, and
   write the design, the rule and the floor of the design into `decision.json` before the first run.
8. Build the two arms in staging from the skill as it stands.
9. Spend the budget in the order item, then repetition, then arm, so the two arms of a repetition run
   next to each other in time.
10. Judge the runs with the preregistered rule, and rewrite `decision.json` with the verdict, the runs,
    the tokens per arm and the interval. The index gains one line: `gate-rejected` or
    `gate-abstained`.
11. On an acceptance, and only then: snapshot the skill into `.history/<timestamp>/`, write the lesson,
    add the reference line to `SKILL.md`, write the record of the write into the snapshot, and append
    `accepted` to the index. If the reference line cannot be written the lesson is withdrawn, because a
    lesson pi cannot reach is inert.

If the index cannot be written, the candidate is removed and the error names both paths. A staged
candidate never exists without its index line.

## What lands on disk

Everything the loop writes on its own lives under `<agent dir>/sri`, the write base: pi resolves the
agent directory itself (`~/.pi/agent` by default, `PI_CODING_AGENT_DIR` when set), so an upgrade or a
reinstall of the package never removes a candidate, and nothing is written inside the installed
package.

```
<agent dir>/sri/
├── staging/<timestamp>/<skill>/
│   ├── lessons/<slug>.md                  the candidate, with frontmatter
│   ├── decision.json                      evidence, diagnosis, gate block, outcome
│   ├── arms/incumbent/<skill>/            the skill as it stands
│   ├── arms/candidate/<skill>/            the skill plus the lesson and its reference line
│   └── gate/runs/<item>-<rep>-<arm>.jsonl the raw output of every run
└── state/attempts.jsonl                   one event per line, append only
```

The `arms/` and `gate/runs/` entries appear when the gate runs: a candidate whose gate never started has
neither. One file per run that produced output, named after the item, the repetition and the arm, so a
row of `decision.json` and the bytes behind it are the same coordinates.

An acceptance is the one thing this package writes inside a skill, and it writes three things there:

```
<skill dir>/
├── SKILL.md                               gains one reference line under ## Lessons
├── lessons/<slug>.md                      the accepted lesson
└── .history/<timestamp>/
    ├── SKILL.md                           the skill as it was
    ├── lessons/                           the lessons as they were
    └── decision.json                      the record of the acceptance
```

The history snapshot is taken before the first edit, and a timestamp that already exists is refused
instead of overwritten: history is never rewritten. The record of the acceptance is written into the
snapshot only after the bytes of the skill are verified, so a record that says `accepted` cannot
describe a write that did not happen.

The index line, the session entry and the `details` of the tool name those paths relative to the write
base (`staging/<timestamp>/<skill>/...`), so a record stays readable after the agent directory moves,
and `details` carries the base next to them. The answers print the absolute path, because a relative
one cannot be opened from the session's working directory. `candidate.lessonPath` in `decision.json` is
relative to the candidate directory itself (`lessons/<slug>.md`).

`decision.json` follows [schemas/decision.schema.json](schemas/decision.schema.json), schema
`pi-simple-sri/decision@1`. A candidate written by an earlier version of this package is refused
rather than migrated: the gate reads one schema, and a record it cannot read is a candidate that has to
be proposed again.

The events of the index are `proposed`, `no-evidence`, `not-eligible`, `no-model`, `accepted`,
`gate-rejected` and `gate-abstained`. A gate that passes writes no line of its own: the intermediate
state lives in `decision.json` as `gate-accepted`, and the line is the `accepted` event the acceptance
writes when it edits the skill, joined to the rest by the hash of the candidate.

The session entry appears in `/tree` under the type `skill-improvement`. It stays out of the model
context.

## Configuration

Skills are eligible by default. To restrict them, add a top-level key to `~/.pi/agent/settings.json`:

```json
{
  "pi-simple-sri": {
    "skills": {
      "allow": ["<skill-a>"],
      "deny": ["<skill-b>"]
    }
  }
}
```

Names are exact, not globs. `deny` wins over `allow`, and an empty or missing `allow` means every
skill is eligible. A skill is checked under both of its names, the frontmatter `name` and the
directory name, because pi accepts that the two differ. The file is only read.

## Safety

- Outside an acceptance the loop writes only under the write base, `<agent dir>/sri`, in `staging/` and
  `state/`. An acceptance writes inside the skill, and only there: the lesson, one line of `SKILL.md`
  and the history snapshot. A write base that falls inside a skill directory is refused before anything
  is written: both sides are compared through the existing part of their paths, so a symlink pointing
  into a skill is caught too.
- Every write goes through one chokepoint: the target is checked against the write perimeter with
  resolved paths -- the write base, the skill directory, its `lessons/` and its `.history/` -- written
  to a temporary file, renamed, then read back and compared byte by byte.
- The one write that is not a temporary file and a rename is an append to the index: one line, one
  write, on a handle opened for appending, verified against the tail of the file. Two pi sessions
  appending to the same installation at the same moment do not overwrite each other's line.
- Writes to the same file are serialized inside the process, and a file that is a symlink is written
  through the link instead of being replaced by a regular file.
- The lesson is verified against the hash of the candidate before it lands, and `SKILL.md` is verified
  against the hash the gate saw: a skill edited between the gate and the acceptance is refused instead
  of published.
- Without a model, or with an aborted signal, a proposal writes nothing at all: no candidate and no
  index line. A gate that is aborted or runs out of its twenty minutes abstains and keeps what it
  already wrote -- the preregistration, the raw output of the runs it spent, and its line of the index.
- The two arms of the gate are copies inside staging; a replay never reads or edits the real skill.
  Its child process is not sandboxed, though: it runs in the working directory of the failing turn with
  the user's tools, which is why the cost of running the gate is a risk of the working tree and not
  only of the wallet.
- JSON and print modes have no UI, so the result goes through the session message channel instead of
  a notification.

## Limits

- A new session has no evidence, so the command reports that there is nothing to improve. The failure
  has to happen in the current branch.
- Standalone `.md` skills cannot be improved. They have no directory of their own for `lessons/`.
- Acceptance needs a passing gate and nothing else: there is no override, no `--force`, and no way to
  write a lesson into a skill from the tool.
- The gate is expensive and hard to satisfy. A lesson has to pass every one of six runs while the skill
  it replaces misses at least one, so a rejection or an abstention is a normal answer and not a defect
  of the run.
- The session is not reloaded after an acceptance, so the lesson is active from the next session.
- The proposal is one model call capped at 2048 tokens. A longer lesson fails validation instead of
  arriving truncated.
- The audit index is append-only and per installation: every event is a line, and there is no rotation
  or pruning.

## Roadmap

- M2: reload after acceptance so the new lesson is active in the same session.
- Later: automatic evidence collection, typed diagnosis, acceptance, rejection and regression metrics,
  retirement of lessons by merit, and the recursive step where the generator is versioned and evaluated
  the same way.

## More

- [DEVELOPER.md](DEVELOPER.md): layout, tests and the rules that came out of the design.
- [REFERENCES.md](REFERENCES.md): the papers the design draws on.
- [CHANGELOG.md](CHANGELOG.md).
- [schemas/decision.schema.json](schemas/decision.schema.json).

## License

MIT
