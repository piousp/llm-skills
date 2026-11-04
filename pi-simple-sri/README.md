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

This release also accepts an improvement that has no failure behind it. A case bank -- a JSON file the user
writes -- declares the cases the skill has to answer and what a good answer contains, and the gate measures
the candidate against that file instead of against a turn of the session. The bank is this package's own
format, one versioned contract, so an improvement can be asked for, re-run and audited after the session
that wanted it is gone.

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

### When the material is a file, not a failure

Not every improvement starts from something that broke. A review finding, a rejected draft, a rule the
skill should follow -- those are measured by a case bank, and three flags choose the material and the gate:

```
/skill-improve <skill> --bank=<path> [focus]
/skill-improve <skill> --bank=<path> --defect [focus]
/skill-improve <skill> --staged=<stagingPath> [--bank=<path>]
```

`--bank=<path>` asks for a directional improvement: the candidate is written from the ask, and the cases of
the bank are what the gate replays. `--bank=<path> --defect` asks for the same thing from a defect an
artifact shows, and `--defect` without `--bank` is a usage error before anything is read. `--staged` gates a
candidate that is already in staging instead of proposing a second one, and it names the bank when the
candidate was proposed with one, because the bank is what measures it: a candidate proposed from a defect needs
no bank at gate time, because the cases it answered are already in its record. Each flag is one token with its
value after the equals sign, and `--` ends the flags, so a focus with spaces in it arrives whole.

The tool carries the same two fields:

```
skill_improve {action: "propose", skill: "<skill>", bankPath: "<the bank>"}
skill_improve {action: "propose", skill: "<skill>", bankPath: "<the bank>", defect: true}
skill_improve {action: "gate", skill: "<skill>", stagingPath: "<the candidate>", bankPath: "<the bank>"}
```

A session that starts prints one line naming the four ways of giving feedback and the cost of the gate, and
nothing more; a session pi reloaded prints nothing, because the reader has just read it. `/skill-improve`
with no argument offers the same four, next to the skills that are eligible.

## Improving without a failure

The gate of the replay base answers a question about a failure that already happened: does the lesson make
that turn succeed? A case bank answers a question the user asks instead, so it needs no failure in the
session, no turn to replay and no evidence derived from the transcript.

### The format

A bank is one JSON object, and `format` is the version of the contract:

```json
{
  "format": "pi-simple-sri/case-bank@1",
  "description": "The two answers the lesson on rebase flags has to fix.",
  "rubric": "PASS only if the answer gives the flag the case asks about and claims no option that does not exist. Length, wording and formatting do not decide it.",
  "cases": [
    {
      "id": "names-the-interactive-flag",
      "prompt": "which flag starts an interactive rebase",
      "checks": [
        { "kind": "contains", "value": "--interactive" },
        { "kind": "not-contains", "value": "--squash-all" }
      ]
    },
    {
      "id": "refuses-the-invented-flag",
      "prompt": "does git rebase accept --squash-all",
      "checks": [
        { "kind": "regex", "pattern": "\\b(no|not|never)\\b", "flags": "i" },
        { "kind": "not-regex", "pattern": "\\byes\\b", "flags": "i" }
      ]
    }
  ]
}
```

That file is valid against [schemas/case-bank.schema.json](schemas/case-bank.schema.json), and the rules
behind it are these:

- `format` is `pi-simple-sri/case-bank@1` and nothing else. A bank of another version is refused whole
  instead of being read as this one with fields missing.
- `cases` holds two to fifty cases. Two is the floor because one case cannot tell a candidate from the
  skill it would replace, and the gate spends its budget over at most three of them, in the order of the
  file.
- A case has an `id` that is a slug and unique in the bank, a `prompt` of at most 4 000 characters, and at
  least one check. Every check of a case has to pass: an OR is two cases, because the rule of the gate is
  unanimity between cases.
- `contains` and `not-contains` compare a literal substring, case-sensitively. `regex` and `not-regex`
  compile a pattern of at most 500 characters with flags `""` or `"i"`, and nothing else: there is no
  `g` and no `y`.
- The checks read the final answer of the replayed turn and nothing else, so a case is about what the
  skill answers, not about which tools it used. A turn that answered with no text fails before any check
  is evaluated, so a `not-contains` cannot pass over an empty answer.
- `description` is for humans and never enters a prompt. The file is capped at 1 MiB before it is parsed,
  and every level of it is closed: a misspelled field is refused by name instead of ignored.

### Two profiles of the same file

One format, two readings, and the invocation says which one. The file carries no discriminator, because a
bank that is not there still has to be read as one of the two.

- **`baseline`** is the branch of `--bank=<path>`. It may declare a `rubric`: the criterion the judge applies
  to every case of the attempt, verbatim.
- **`origin`** is the branch of `--bank=<path> --defect`. It requires an `origin` and forbids a `rubric`: a
  defect has a truth observable in the artifact, and a rubric would leave the judge deciding something the
  artifact already says.

The same two cases as an origin bank:

```json
{
  "format": "pi-simple-sri/case-bank@1",
  "origin": {
    "kind": "review-finding",
    "path": "notes/review.md",
    "excerpt": "It recommends --squash-all, which git rebase does not accept."
  },
  "cases": [
    {
      "id": "names-the-interactive-flag",
      "prompt": "which flag starts an interactive rebase",
      "checks": [{ "kind": "contains", "value": "--interactive" }]
    },
    {
      "id": "refuses-the-invented-flag",
      "prompt": "does git rebase accept --squash-all",
      "checks": [{ "kind": "regex", "pattern": "\\b(no|not|never)\\b", "flags": "i" }]
    }
  ]
}
```

`origin.kind` is `review-finding` or `rejected-draft`, `origin.path` is resolved against the working
directory of the invocation, and `origin.excerpt` is the entry that does not hold, at most 200 characters.
A path the run cannot read is a refusal before the model is called: a defect with no artifact to name has
nothing to measure.

### What the gate does with a bank

1. Read the bank once, under the profile the invocation declared, and plan the design over its first three
   cases: two repetitions of each case for each of the two arms, so `2 x 2 x min(cases, 3)` runs -- eight
   with two cases, twelve with three or more.
2. Copy the bank next to the candidate, inside staging, and read the copy back: the digest the record
   pins is the digest of a file that is there.
3. Preregister, before the first run: the moment, the design, the floor of the design, the rule, the path
   and digest of the bank, the copy that travels with the candidate, and the digest of the rubric when the
   bank declares one. The rubric lives inside the copied bank, so it is pinned by bytes nobody could have
   chosen after seeing the result.
4. Build the two arms from the skill as it stands, exactly as the replay base does, and record the digest
   of the `SKILL.md` they were copied from.
5. Spend the budget: case in the order of the file, then repetition, then incumbent and candidate. Every
   run is judged by the checks of its case, and a run nobody can read abstains the gate.
6. Apply the rule the replay base applies -- the candidate passes every run of its arm and the incumbent
   misses at least one -- and then, only if the bank declared a rubric, the judge.
7. Write the verdict into `decision.json` and one line into the index: `gate-rejected` or
   `gate-abstained`, never `gate-accepted`, which stays a state of the record. The acceptance that follows
   is the one of the replay base, unchanged.

### What the judge guarantees

The mechanical rule is a necessary condition and never a sufficient one. When the bank declares a rubric,
the gate asks a judge -- a model call, the model of the session, one per case, on the first repetition of
the candidate arm -- and the answer is a second condition that can only subtract:

- The rule is applied first, and a candidate it refused is rejected whatever the judge would have said. The
  judge is never asked about a comparison the mechanics already lost.
- The answer under judgement travels delimited as data, and the verdict is read off the first non-empty line
  of the reply. An instruction embedded in the answer cannot change the verdict, because the verdict is not
  read from the prose.
- A `FAIL` rejects the candidate (`judge-failed`). A call that failed, a reply that does not open with a
  verdict, or a model that never finished is an abstention (`judge-unavailable`) and never an acceptance:
  the gate announced a condition and could not apply it, so it says nothing rather than deciding alone.
- The rubric is not rewritten, not summarized and not paraphrased: the judge receives it verbatim, and its
  digest is in the preregistration.

The judge is the model of the session, so the same model proposes the lesson and judges the answers. The
mechanical checks over the cases are what it cannot overrule.

### Without a bank there is no directional acceptance

A bank that is absent, unreadable, over its cap, not JSON or not a bank of this version is the answer
`no-baseline`: nothing is spent, the candidate stays in staging, the skill is not touched, and the record
keeps `not-run` -- the true state of an attempt that the gate never concluded. That is why the attempt is
retryable: once the bank is in place, `--staged` with the candidate path gates the same candidate without
paying for the proposal twice.

```
/skill-improve <skill> --staged=<the staging path of the candidate> --bank=<the bank>
```

A directional run also needs the model of the session, once to replay the cases and once to judge the
answers. A session with none is refused by the gate before the bank is read, so no run is spent; a proposal
may already have been made, and it is the gate that cannot run.

### A defect

The `--defect` branch reads the artifact the bank names, hashes its bytes, and turns it into one evidence
item of class `quality_defect` carrying the `origin` -- how the defect was found, where it is, the digest of
the bytes and the entry that does not hold. The cases of the bank become the replay items, one per case, and
the paired replay of the replay base measures them. The artifact is re-verified against the digest the
record kept before the first run, so an artifact that moved abstains the gate instead of measuring a
different defect.

A `--defect` bank that is absent, unreadable or of the other profile is reported as `no-evidence` with the
problem in the reason, and so is an artifact the run cannot read: no generation is spent.

## What the gate does

The gate has two bases, and `gate.basis` in `decision.json` says which one decided: `replay`, which measures a
lesson against the turns that failed in the session, and `case-bank`, which measures it against the cases of
a file the user wrote. The two share the paired budget, the rule, the vocabulary of abstention and the
acceptance, and differ in the material and in one extra condition. What follows is the base of the replay;
the base of the bank adds the judge, described in [Improving without a failure](#improving-without-a-failure).

The gate answers one question: does the lesson make the failing turn succeed, reliably enough that it
is worth changing the skill for? It answers it by replaying the failure under two conditions. In plain
language:

- **Two paired arms.** The skill is copied twice into staging and the failure is replayed against both
  copies. Both arms carry a `## Lessons` section, because an arm without it would not be comparable with
  the candidate, which needs the section for the new lesson: where the skill has none, an empty one is
  added to both copies. The incumbent arm is the skill as it stands, with that section empty of this
  candidate; the candidate arm is the same skill plus one reference line in the section and the lesson
  file the line points at. Everything else -- the rest of `SKILL.md`, the other lessons, the files of the
  skill -- is identical, so a difference between the arms is about the lesson.
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
- **Abstention as a result.** The plan is also preregistered as a floor: `2 x min(items, 3)` runs per
  arm resolve a difference of one run and no finer one -- a quarter with two items, a sixth with three --
  while the rule asks for a difference of one whole pass rate. When the two arms come out identical, or
  when a run proves nothing about the skill, the gate abstains instead of claiming a result. The recorded
  interval is descriptive and never decides.
- **Verdicts that fail closed.** A run that broke -- a kill, a timeout, a non-zero exit, a stream nobody
  can read, a missing working directory, or a skill that did not load -- abstains the whole gate,
  because the broken arm is the baseline the other arm is compared against. A tool result marked as an
  error is a failure of that run and not a discard: the incumbent is supposed to reproduce its own
  failure.

The gate accepts a candidate, rejects it, or abstains. Rejected and abstained candidates both leave the
skill untouched; what separates them is that a rejection is evidence against the lesson and an
abstention is the absence of evidence either way. On an acceptance the lesson is written into the
skill, next to a copy of the skill as it was, and the record of the write is kept beside that copy.

An abstention reached before the budget is spent leaves `decision.json` as it was. `insufficient-items`,
`no-model` and `skill-unavailable` stop before the preregistration, so `gate.status` stays `"not-run"`,
and `overlay-failed` stops after it, so the status stays `"preregistered"`. That is the true state of the
record, not a gap in it: the gate did not conclude. The reason such an abstention is about lives in the
line the index gains and in the answer, and the record is rewritten with a verdict only once the gate has
gone on to spend its budget -- the abstention of an interrupted gate included, which is a verdict about
the runs it did not get.

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
- The judge of a bank adds at most one call per case, capped at 256 tokens of output, and only when the
  mechanics already accepted. What it cost is recorded next to what the runs cost.
- Every run keeps its raw output under the candidate, truncated at 2 MiB per run, so the verdict can be
  audited without re-running anything.

**A replay is a real session and it can write to the project.** The child inherits the working directory
the failing turn was answered in and the same tools the user has, so a replayed turn that edits, moves
or creates files does exactly that in that directory. Replay is measurement inside the user's own
working tree, not a sandbox: run the gate on a project whose state can be restored, or in a copy of it,
and expect the working tree to look as it did after a failed turn. A run of a bank has no failing turn to
inherit a directory from: it runs where the command or the tool call was made.

## What counts as a failure

| Signal | When it is recorded |
|---|---|
| Tool error | A tool result comes back with `isError` |
| User correction | The user replies after a tool error, before another tool result |
| Retry loop | The same tool runs three or more times with the same arguments, successful or not |
| Quality defect | A bank of profile `origin` (`--bank=<path> --defect`) names an artifact and the entry that does not hold; the bytes of the artifact are read and hashed, and the checks of each case are what a replayed answer has to satisfy |

Each of the first three signals becomes an evidence item with a deterministic id, a hash of its canonical
arguments and the assistant cycle it belongs to. Repeated evidence is deduplicated by that id. The fourth
is read from a file and not from a turn: its id is derived from the artifact, its kind, the resolved path
and the digest of its bytes, and the entry that does not hold travels as the excerpt.

A diagnosis built from the session needs at least one replayable item: one with the user prompt that led to
it and the mechanical expectation the gate can execute -- which tool call, or which correction, has to stop
failing. An item without a prompt, or a tool failure without a tool name, is not replayable and does not
displace one that is. Each replay item also carries the model that produced the failing turn, as
`provider/model`, because a replay under another model is not the same failure.

An expectation names the failing tool exactly when its class is one of the two tool classes, and carries
the checks of a defect exactly when its class is a defect. The schema cannot state either relation -- it
ties no property to another -- so one function in the package owns both, and no writer of this version
produces a record that breaks them. A directional attempt is the one shape with no replay item at all: the
turns it replays are the cases of its bank, which the gate supplies when it runs, so its diagnosis is the
ask and an empty list there is its correct value.

## The loop

The list below is the loop of the replay base -- a run that learns from a failure of the session. A run
that names a bank follows the order in [Improving without a failure](#improving-without-a-failure): it reads
no transcript, derives no evidence from it, and the bank supplies the items the gate spends.

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
    `gate-abstained`. An abstention that stopped before this step judged no runs and rewrites nothing:
    the record keeps `not-run`, or `preregistered` when the arms were already being built, and the line
    and the answer are where its reason is reported.
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
│   ├── case-bank.json                     the bank the gate measured, copied from the one it read
│   ├── decision.json                      evidence, diagnosis, gate block, outcome
│   ├── arms/incumbent/<skill>/            the skill as it stands
│   ├── arms/candidate/<skill>/            the skill plus the lesson and its reference line
│   └── gate/runs/<item>-<rep>-<arm>.jsonl the raw output of every run
└── state/attempts.jsonl                   one event per line, append only
```

The `arms/` and `gate/runs/` entries appear when the gate runs: a candidate whose gate never started has
neither. One file per run that produced output, named after the item, the repetition and the arm, so a
row of `decision.json` and the bytes behind it are the same coordinates. `case-bank.json` appears only for
a candidate measured by a bank, and it is a copy of the file the user wrote: the cases and the rubric the
gate judged travel with the attempt, so the record can be read years after the bank changed.

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
`gate-rejected`, `gate-abstained` and `no-baseline`. A gate that passes writes no line of its own: the
intermediate state lives in `decision.json` as `gate-accepted`, and the line is the `accepted` event the
acceptance writes when it edits the skill, joined to the rest by the hash of the candidate. `no-baseline`
is the one event of a gate that never started, and it is why the attempt it names is retryable.

`decision.json` also records which base decided the gate. A block of the `case-bank` base carries the
result under `caseBank` and keeps `replay` at `null`, because schema 1 requires that key of every block; a
block of the `replay` base has no `caseBank` key at all. A record therefore says how it was measured
without a reader guessing it, and the acceptance reads neither key.

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

- A new session has no evidence, so the command reports that there is nothing to improve: the failure has to
  happen in the current branch. A run that names a bank is the exception, because a bank needs no failure of
  the session to measure.
- Standalone `.md` skills cannot be improved. They have no directory of their own for `lessons/`.
- Acceptance needs a passing gate and nothing else: there is no override, no `--force`, and no way to
  write a lesson into a skill from the tool.
- The gate is expensive and hard to satisfy. A lesson has to pass every run of its arm -- four with two
  items, six with three -- while the skill it replaces misses at least one, so a rejection or an
  abstention is a normal answer and not a defect of the run.
- The session is not reloaded after an acceptance, so the lesson is active from the next session.
- The proposal is one model call capped at 2048 tokens. A longer lesson fails validation instead of
  arriving truncated.
- The audit index is append-only and per installation: every event is a line, and there is no rotation
  or pruning.
- A bank is a file the user writes, and the package runs its patterns. The checks are executed by the
  JavaScript regular-expression engine, so a pattern with catastrophic backtracking can hang the
  evaluation of a run: the answer under judgement is cut at 16 000 code points and a pattern at 500
  characters, and neither makes that engine safe. A bank is trusted input, written by the same person who
  runs the gate.
- A directional attempt is measured by at most three cases, whatever the bank holds. A bank of more than
  three cases is not a longer gate; it is the same budget over the first three, in the order of the file.
- Without a readable bank there is no directional acceptance. The attempt answers `no-baseline` and nothing
  is spent, so a bank that is not there yet costs the proposal and not the gate.
- The judge is the model of the session, and it is the same model that wrote the lesson. It cannot accept a
  candidate the mechanical checks rejected, and the checks are the part it has no vote on.

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
