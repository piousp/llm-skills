---
name: improving-skills
description: "Teaches the pi-simple-sri improvement loop: the skill_improve tool with its four actions, diagnose, propose, gate and validate; the /skill-improve command, the only surface that accepts a lesson into a skill; the replay budget a gate spends; the four classes of failure a replay can measure; how a verdict, a rejection and an abstention are read; and the case bank that measures an improvement, which the user writes. Use when the user asks to improve, diagnose or measure a skill of the session inventory, asks what a gate verdict means, or wants a case bank for a skill."
---

# The improvement loop

## What this is

The loop is what has to be understood before a skill is touched: the package has one loop, and the loop has four
steps. It observes a failure, it proposes one change to a skill, it gates the change by replaying the work against
the skill as it stands and against the skill with the change, and it records the decision. A change is one lesson: a
short procedural note, stored as a file inside the skill, that pi reads the next time it applies that skill.

Two surfaces drive the loop, and they do not have the same powers. The `skill_improve` tool is what the model calls,
and it carries four actions: `diagnose`, `propose`, `gate` and `validate`. The `/skill-improve` command is what the
user types, and it runs the chain that ends in a write: it proposes, it gates and it accepts. Only the command
accepts. An acceptance writes the lesson into the skill, adds one reference line to its `SKILL.md` and takes a
snapshot of the skill before the first edit, so the tool has no action, flag or argument that edits a skill.

Every write outside a skill lives under the write base, which is `<agent dir>/sri`, in `staging/` and `state/`, and a
`propose` writes one session entry besides the candidate it stages. The acceptance is the only write inside a skill,
and it takes the snapshot before the first edit, so the record of what the skill was survives the change.

## What the model runs and what the user decides

Diagnosing and validating are free at any moment: `diagnose` reads the session and the skill, `validate` reads one
case bank, and neither calls a model, writes a byte or spends a run. Running them whenever the answer would sharpen
a diagnosis is correct, and most sessions start with `diagnose`.

Proposing belongs to the model only when the user asked for an improvement: a proposal spends one model call and
writes a candidate under the write base, so an improvement nobody requested leaves a candidate behind and one model
call spent.

Gating is the user's decision and never the model's: the gate spends the replay budget described below, the most
expensive thing this package does, and the user is the one who decides to pay it. When the user asks what a gate
would cost, the answer is the numbers and nothing else.

Accepting is not the model's at all: there is no action that edits a skill and no flag that turns one into an
acceptor, so a lesson lands only when the user runs `/skill-improve` and the gate of that same invocation accepts. The
same command is the only surface that takes a lesson back out of use: `--retire=<slug> --reason=<key>` retires one
accepted lesson, and no other surface edits a skill.

The cases of a case bank are the user's writing. A case is a question the user wants measured and the condition
that makes an answer pass, in the user's words. The model may propose a draft and explain what a check would mean,
but no case reaches a file until the user has confirmed it in a numbered round of the conversation, and
`references/case-bank.md` holds the procedure.

The rest is configuration, and two facts decide whether a skill is eligible. The settings
`pi-simple-sri.skills.allow` and `pi-simple-sri.skills.deny` decide it: `deny` wins over `allow`, and an empty
`allow` admits every skill. The other is a fact of the package about a name it reserves: the skill this package
publishes is named `improving-skills`, and no skill that answers to that name is eligible, with the reason
`published-by-this-package`, which no setting changes. Both arrive as `not-eligible`, and the reason in the answer
says which one it was.

## The four actions and what each costs

The four actions are priced differently, and the price is what decides who may run them:

- `diagnose` costs nothing: no model call, no write, no run. It derives the evidence from the current branch of the
  session, names the failure signature, and lists the replay items it would measure. Its answer is `diagnosed`, or
  `unknown-skill`, `no-evidence` or `error`; a skill the settings exclude is diagnosed too, and the answer says which
  verdict a candidate would meet.
- `propose` costs one model call whose output is capped at 2048 tokens, one write of the candidate under
  `staging/<timestamp>/<skill>/`, one line in the audit index and one session entry. Its answer is `proposed`, or
  `no-evidence`, `not-eligible`, `unknown-skill`, `no-model` or `error`.
- `gate` costs the replay budget: two repetitions per item, two arms, and at most three items, which is eight runs
  with two items and twelve with three. Every run is a whole pi session in a child process, so a run spends the
  tokens of a full turn and the token count is not bounded by the design. The clock is what is bounded: 180 s per
  run and twenty minutes for the whole gate. A run that reaches its 180 s is broken, and one broken run abstains the
  whole gate with `invalid-run`; a gate that reaches the twenty minutes, and a call the user cancelled, abstain with
  `interrupted`. A bank that declares a rubric adds at most one call per case, capped at 256 tokens of output, and
  only after the mechanical rule already accepted.
- `validate` costs nothing: one file read, one parse, no model call, no write, no run. Its answer is `bank-valid` or
  `bank-refused`, and a call that names no `bankPath` answers `error` with the reason `missing-bank-path`.

A gate is spent in the order item, then repetition, then arm, so the two arms of one repetition run next to each
other in time. A run writes its raw output under the candidate, which is what makes a verdict auditable without
running anything again.

### Two measurements, not one

A candidate from the tool is not accepted on one gate: acceptance needs the `gate-accepted` verdict of the same
invocation of the command, so `/skill-improve <skill>` proposes, gates and accepts in one run, and
`/skill-improve <skill> --staged=<stagingPath>` enters the gate again for a candidate that is already in staging. A
`gate-accepted` from a `skill_improve` gate call therefore lands nothing: it says the candidate is worth the second
gate, and the second gate is the one the acceptance is built on. An economy of one gate does not exist.

## What a replay can measure

A failure belongs to one of four classes, and three of them come from the session while the fourth comes from an
artifact, in order of strength:

1. A tool error: a tool result came back with `isError`.
2. A retry loop: the same tool ran three or more times with the same arguments.
3. A user correction: the user replied after a tool error, before another tool result.
4. A quality defect: a case bank of profile `origin` names an artifact and the entry that does not hold.

Only the class of the strongest failure present enters the gate. If the session holds a tool error, the retry loops
and the corrections of that same session are not measured, because a stronger class is a failure the replay can
prove directly.

Two conditions make an item not replayable, and neither is a failure of the run: a failure whose user prompt is
unknown has nothing to replay, and a tool failure with no tool name cannot say what has to stop failing. Both are
dropped before the class is chosen, so a failure that cannot be replayed never hides one that can.

Two failures that measure the same task are one item, and the key is the class, the condition the replayed answer
is judged by, and the normalized call; when the evidence carries no arguments, the prompt stands in for the call.
The first of an equivalence survives, in the order the evidence gave it, so the same evidence always plans the same
runs.

The floor is two distinct items and the cap is three measured. Fewer than two and the gate abstains with
`insufficient-items` before spending a run, because one item compares a run against itself. More than three and the
gate spends the same budget over the first three, in the order the evidence gave them, so a longer session does not
buy a longer gate.

The cases of a bank are the fourth class, and their checks are the expectation the replay is judged by. The checks
read the final answer of the replayed turn and nothing else, so a case measures what the skill answers and not which
tools it used. A turn that answered with no text at all fails before any check is evaluated.

## Reading an answer

The answer of a call carries an outcome, and the outcome decides what happens next.

| Outcome | What it means and what follows |
|---|---|
| `diagnosed` | Nothing was spent. The answer names the failure signature and the items a replay would test. A proposal is the next step only when the user asked for an improvement. |
| `proposed` | The candidate is in staging and nothing has been measured. The gate is the next step and it needs the user's agreement. |
| `gate-accepted` | The candidate passed every run of its arm and the skill it replaces missed at least one. Nothing landed: the acceptance is a second gate, and only the command runs it. |
| `gate-rejected` | The candidate did not pass every run of its arm, which the reason spells `below-threshold`, or the rubric the bank declares was not one the judge accepted, which it spells `judge-failed`. This is a normal answer and not a defect of the run. |
| `gate-abstained` | The gate could not decide. The reason names the one that stopped it, out of `insufficient-items`, `no-improvement`, `invalid-run`, `interrupted`, `no-model`, `skill-unavailable`, `overlay-failed`, `candidate-mismatch`, `judge-unavailable` and `origin-moved`. This is a normal answer too. |
| `no-baseline` | The bank that a directional attempt needs could not be read, so no case was replayed and nothing was spent. The reason names the first violation, the candidate stays in staging, and the retry is `/skill-improve <skill> --staged=<stagingPath>` once the bank is there. |
| `bank-valid` | The bank was read as data under the profile the call declared. |
| `bank-refused` | The bank could not be read: absent, unreadable, over the byte cap of the format, not JSON, or holding a violation, which the reason names as its first one. Nothing was spent and nothing was written. |
| `not-eligible` | Two causes, and the reason in the answer names which one: the settings `allow` and `deny` exclude the skill, or the skill answers to the name `improving-skills`, which this package reserves with `published-by-this-package` and no setting changes. |
| `no-evidence` | The session holds no replayable failure, or the artifact or the bank of a defect could not be read. |
| `unknown-skill` | No skill of the inventory answers to that name, which is also the answer for a standalone `.md` file: it is in the inventory and it is no candidate, because it has no directory of its own for lessons and history. The answer offers the eligible set instead of guessing a spelling. |
| `no-model` | The session has no model, so nothing can be proposed and a bank cannot be replayed. |
| `error` | Everything else: a generation that produced no lesson, a lesson that does not validate, a write the perimeter refused, a call missing an argument it cannot do without, or a bug. The message is the whole answer. |

The rule of the gate is unanimity plus strict superiority: the candidate has to pass every run of its arm, which is
four runs with two items and six with three, and the skill it replaces has to miss at least one. The rule is written
into the record before the first run and cannot be chosen once the result is known.

An abstention is not a failure and a rejection is not a mistake. Both are the loop working: the budget was spent,
the record keeps what it cost, and the skill was left alone.

### What the rates of the series measure

`/skill-improve --metrics` reads the index of attempts under the write base and prints the numbers of the series, and
it spends nothing: no generation, no gate, no model call and no write. The acceptance rate is the share of the attempts
that reached a gate that the acceptance accepted, over the attempts that reached one. The recurrence rate is the
definition of a regression this package uses: of the accepted lessons still in force, how many saw their failure class
come back, which is a later attempt of the same skill hitting the class of failure the lesson had corrected. The gate
regressions are a different fact, and they travel as a column of support: the pairs of runs the gate replayed on which
the incumbent passed and the candidate did not, so a regression there is about one candidate and says nothing about the
lessons a skill carries. The last line splits the failed runs of a quality defect by their cause, a turn a tool sank
before there was text to judge or a text that did not pass the checks.

Both rates cover the records the index still names and nothing else. A staging directory that is pruned takes the
record of a rejected attempt away and leaves its line behind, so the report says how many records are missing and reads
as the measurement of what is still on disk. A rate whose denominator is zero is not printed as a number: the line says
instead that there is nothing to measure yet.

### What the check of an accepted lesson reads

`/skill-improve --verify` checks an accepted lesson against the record that accepted it -- the bytes of the file, the body
they carry and the reference line of `SKILL.md` that makes pi load it -- without measuring it again, and it does not read
the frontmatter of the lesson as a verdict. A candidate the gate rejected stays in `staging/` carrying the same
`status: "accepted"` the lesson it would have been carries, so the record is the authority and the header is not. One
state is named per lesson, out of `intact`, `frontmatter-moved`, `body-moved`, `missing` and `unreadable`, next to the
worst state of each skill, and the report counts the acceptances it could not check because their record is not readable
any more. It reads the index of attempts under the write base, it takes no other flag, and it spends nothing: no
generation, no gate, no model call and no write.

### What a retirement takes back

`/skill-improve <skill> --retire=<slug> --reason=<key> <detail>` retires one accepted lesson of a skill, and it is the
second and the last thing this package writes inside a skill. A retired lesson is not deleted: the file stays where it is
and its frontmatter says `status: "retired"`, and its reference line leaves the `## Lessons` section, so pi stops loading
it. The run writes, in this order, a snapshot of the skill under `.history/<timestamp>/`, the section without that line,
the tombstone in the lesson file, the record of the reason in `.history/<timestamp>/retirement.json`, and one `retired`
line in the index of attempts, which joins the acceptance of that lesson by the hashes it carries.

The reason is a key of a closed vocabulary plus the sentence of the user, which is the focus of the run: `stale` for a
lesson the skill no longer meets, `superseded` for one a better lesson replaced, `ineffective` for one that was measured
and did not hold, `wrong` for one that is false, and `unreferenced` for one nothing loads any more. A retirement needs the
acceptance: the index has to carry an `accepted` line for that slug of that skill, and the bytes on disk have to be the
ones that acceptance measured. A file whose bytes moved is refused as `lesson-drift`, a slug no acceptance names as
`never-accepted`, and an index that stops at a truncated line as `unreadable-index`, because the line an interrupted
append cut may be the acceptance itself. None of the three writes anything.

There is no unretire. The way back is another lesson: `/skill-improve <skill>` proposes one, the gate measures it, and the
acceptance writes it next to the retired file, which stays in the skill as the record of what was taken back. A retirement
is the user's decision and never the model's -- the tool has no action, flag or argument that retires a lesson -- and it
spends no run: no model, no gate and no candidate.

## The case bank

The form of the bank, the four kinds of check, the validation of a draft and the interview that writes the bank with
the user are in `references/case-bank.md`, which is read before writing or reviewing a bank.

## Silent signals

Two things a session does are worth a second look, and the extension notices both while the session happens, with no
model call, no process and no run:

- `rewritten-draft`: a call to `write` or `edit` names a file that an earlier turn already wrote, and the arguments
differ. Two calls on the same file inside one turn are the model refining its own draft, and they raise nothing.
- `repeated-request`: the prompt of the user of a turn repeats, in substance, the prompt of an earlier turn. The
  significant tokens of the shorter prompt -- what is left after splitting on everything that is not a letter or a
  digit, lowercased, five characters or more -- are contained in the longer one's, and at least three of them are
  shared.

A suspicion is not a defect. The user may have rewritten the draft by choice or asked twice on purpose, so the
notice names the occurrence and nothing else: it does not edit the skill, it does not spend a run, and it does not
touch the turn. What it does do is keep the suspicion: it is written to `state/signals.jsonl`, under the write base,
with the id `sg-...` that names it, so a suspicion one session raised is still there in the next one and a suspicion
nobody confirmed does not disappear. The same rewrite in another session is a new occurrence, with its own id, and it
is reported again. The notice carries that id and the form of the confirmation, and the confirmation names the
skill because the suspicion does not: a suspicion lives outside the index and carries no skill of its own.

The only thing that turns a suspicion into a measurable attempt is the confirmation of the user:
`/skill-improve <skill> --signal=<id> --bank=<path>`. A confirmed suspicion opens the directional attempt this
package already has, with the bank the user names as its expectation: the cases that file declares are what the
confirmation is measured against, and the suspicion is the focus of the record, spelled `signal:<kind>: <excerpt>` in the
trigger of its `decision.json`, so a line of the index can be traced back to the suspicion it came from. The focus of a
confirmation is the suspicion itself, so the form takes no focus of its own: a focus typed next to `--signal` is a usage
error and not an override of the suspicion, because no field of the record would carry it and it would be lost in silence.
The vocabulary of evidence does not grow: a confirmation names no new class of failure, and the attempt it opens is the one
`--bank` opens.

Without a bank there is nothing to measure a confirmation against, so nothing is spent and the suspicion stays open, and the
same confirmation can be given again with a bank. A suspicion never decides anything on its own: it does not edit the skill,
it does not open an attempt until the user confirms it, and `[NEVER]` treat it as a failure of the session or of the skill.

## What this skill does not do

The limits of this skill are few, and none of them is a matter of taste:

- It does not edit a skill. Lessons land through an acceptance, and an acceptance is the command's.
- It does not accept. There is no action, flag or argument of the tool that writes a lesson into a skill.
- `[NEVER]` gate without a request, because the budget is the user's to spend.
- It does not invent a case, however plausible the question looks.
- It does not repair a bank: `validate` names the first violation and stops, and the correction is the author's.
- It does not improve itself. The name `improving-skills` is the one this package reserves for the manual it
  publishes: no skill that answers to it is eligible, with the reason `published-by-this-package`, because the file
  travels inside the installed tree, an update of the package replaces it, and a note written there does not survive
  that update. `[DO NOT]` propose an improvement of this skill.
