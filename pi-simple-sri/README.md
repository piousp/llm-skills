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

## Learning from past sessions

The observer finds corrections across sessions, so a skill that runs once per session can still be improved. It is
off until you opt in, it never edits a skill, and every lesson it proposes is accepted only by you.

Turn it on in `~/.pi/agent/settings.json`:

```json
{
  "pi-simple-sri": {
    "observe": {
      "enabled": true,
      "judgeModel": "provider/id",
      "limits": { "judgeCallsPerDay": 20 },
      "replay": { "allow": ["my-read-only-skill"] }
    }
  }
}
```

`judgeModel` is optional: without it the model of the session judges. `judgeCallsPerDay` defaults to 20.
`replay.allow` defaults to empty and is explained below. The existing `skills.allow` and `skills.deny` decide which
skills are observed, and `improving-skills` never is.

How it works:

1. **Episodes.** On `session_start` (reasons `startup` and `new`, in the TUI, in a top-level session) a background
   cycle reads the other session files of the sessions directory and cuts them into episodes: one run of one skill,
   either explicit (a `/skill:<name>` message) or implicit (the assistant read the skill's `SKILL.md`). Nothing is
   read from the session in progress, from a file modified less than 30 minutes ago, from a session whose cwd is a
   temp directory or no longer exists, or from a `run-*` subagent directory. Sessions before the moment of opt-in are
   ignored, and nothing is back-filled.
2. **Detection.** A deterministic prefilter flags tool errors, corrections in your own words (English and Spanish),
   rewritten drafts and repeated requests. Only a correction or a repeated request sends an episode to an LLM judge,
   within the daily call budget. A tool error, a rewritten draft or a repeated request is also recorded, as weak
   mechanical evidence, and mechanical evidence alone never opens a pattern. The judge only runs over episodes whose
   recorded provider is the judge's, unless `judgeModel` is pinned. A judge call that fails, or is skipped for lack of a
   model, does not use the episode up: it is judged again at a later start. A session that grew since it was read
   (a resumed one) has its episode read again.
   Episodes of a skill you ran `--forget` on, and older than the forget, are skipped before any judge call.
3. **Evidence.** Other sources feed the same store: `/skill-improve <skill> --note <text>` (your own words, the
   strongest), and the `record` action of the tool (a self-report by the model, weaker).
4. **Patterns.** Observations are grouped into patterns across sessions. A pattern is proposed when it was seen in at
   least 2 sessions on at least 2 UTC days, its decayed weight is at least 1.6, a Beta posterior says the rate is
   above 0.15 with probability at least 0.8, and it is not backed by mechanical evidence alone. Weight decays with a
   90-day half-life and nothing older than 365 days counts.
5. **Proposal.** At most one proposal per 24 hours in total. You get a dialog (a): Later, Approve or Reject. It shows
   the pattern, the lesson, the directory the gate would replay in and, for a bank, its cases and the number of gate
   runs planned (arms x repetitions x items, at most; not how often the pattern was seen). Reject closes that
   candidate until a newer observation arrives. Later or no answer within 60 seconds snoozes it for 24 hours. A
   proposal that cannot be prepared (too few episodes for a bank, a bank that exists but cannot be read, a failed model
   call) is recorded with its reason, the next pattern is tried, and it waits 24 hours after the first
   failure, 72 hours after the second and 7 days after the third or later.
6. **Measurement.** What happens after Approve depends on the skill:
   - A skill you listed in `replay.allow` is gated against its bank: `banks/<skill>.json` under the write base, or
     a `case-bank.json` the skill ships. With no bank, one is generated from at least 2 episodes of at least 2
     sessions in one cwd, before the lesson exists, and you approve the lesson and the bank together in dialog (a).
     With too few episodes the pattern waits, and after 14 days it is offered on probation.
   - Every other skill goes on probation: the lesson is never replayed and the dialog says it was not measured.
7. **Acceptance.** A second dialog (b) shows the result. In the background cycle, Accept sends
   `/skill-improve --review=<id>` as a message, which asks once more and only then writes the lesson and reloads.
   The message is sent only when the session is idle: if it is streaming, it waits for the next time the agent is
   idle and checks again, and if the session is busy then, you get a notice with the command to run by hand (a
   reload run while pi is streaming is dropped, so the package does not dispatch then). In `--scan`, Accept runs
   that review inline in the command, asks once more, and reloads once if you accept. This dispatch was verified on pi 1.5.2
   only; the 1.4.0 development dependency was not tested.

The dialogs state what the gate proves: the lesson makes the bank cases pass, not that the pattern is real. A lesson on
probation is labelled "not measured" and was compared against no case.

### The life of a pattern

- A lesson you accept closes its pattern until a newer observation arrives. "Newer" is the time of the session the
  observation is about, not the moment it was read: an old session scanned late does not reopen it.
- A lesson the gate or you rejected closes that candidate the same way, and the same lesson is never offered again.
- A lesson whose skill changed after it was staged cannot be accepted (the skill is compared with the digest taken at
  staging). It is closed as stale, and the pattern reopens on a newer observation.
- Only the newest proposal of a pattern is live, for the background cycle and for `--review` alike; a restaged candidate
  replaces the earlier ones.
- A gate that could not conclude (interrupted, a broken run, no model, too few items, and similar) is not retried on the
  same candidate: a fresh candidate is staged, twice at most per pattern, and after that the lesson is offered on
  probation.
- `replay.allow` is checked again before a bank is promoted and before the gate runs. A skill you took out of the list
  is not replayed: the answer is retryable and the next candidate is a probation one.

### Commands of the observer

- `/skill-improve --setup` scans your skills for side effects (git push, `gh pr` writes, `curl -X POST`, `rm`,
  `ssh`, scripts and the like) and suggests the read-only ones for `replay.allow`. You confirm each one. A skill
  with no recognisable effect stays unknown and is never suggested; an optional model pass looks at those after
  showing a cost estimate and asking. The result is written to `settings.json`, which is rewritten as JSON with
  2-space indentation, so other formatting in that file is lost. If the file changed while you answered, nothing is
  written and the snippet to paste is printed instead.
- `/skill-improve --scan [--since=YYYY-MM-DD]` runs the cycle now. If you press Accept in its dialog (b), the review
  runs right there in the command and reloads the session once if you accept. With `--dry-run` (and optionally
  `--limit=<n>`, the number of episodes it judges, 30 by default; `--limit` needs `--dry-run`) it writes nothing to the
  store: it estimates the cost, asks first, judges a sample of the most recent episodes (flagged or not) and writes
  `<agent dir>/sri/labeling/<timestamp>.jsonl`. Each line carries pointers and flags, and `label: null`; set it to
  `true` or `false` by hand. In a checkout of this repository (`scripts/` is not published),
  `node scripts/score-labels.ts [file|dir]` prints the precision and recall of the judge and the recall of the
  prefilter.
- `/skill-improve --review[=<id>]` reviews a proposal. The id travels as `--review=<id>`; `--review <id>` with a space
  is refused. It asks dialog (a) first if you never approved the lesson, runs the gate in the foreground if the result
  is missing or retryable, asks (b), and accepts only on your answer. Without an id it takes the newest live proposal
  that still has something to review.
- `/skill-improve <skill> --note <text>` records a correction as evidence of weight 1.0 (at most 300 characters).
- `/skill-improve <skill> --forget` asks for confirmation, then erases:
  - from `observe.jsonl`, the episodes, observations, proposals, failed preparations, tombstones, judgements, prompt
    answers and gate outcomes of the skill;
  - from `signals.jsonl`, the suspicions you confirmed for the skill;
  - the content of its staged candidates that were never accepted (lessons, bank copy and the raw runs of the gate),
    and the bank copy and raw runs of the accepted ones (they hold verbatim prompts and replay transcripts), the drafts
    of banks generated for it, and `banks/<skill>.json` only if the observer generated it;
  - `trigger.focus` and `diagnosis.summary` in every `decision.json` of the skill (staging and the history of accepted
    lessons), which name the pattern.

  It keeps `attempts.jsonl`, the accepted lessons and their history, the lesson copy of accepted candidates, the verdicts
  and decisions of every `decision.json`, banks you wrote or the skill ships (it lists them), and the `forget` event
  itself, which stops older sessions from bringing the skill back; the event is written first, so a later failure never
  leaves the skill half forgotten without it. The report counts the decision records it cleared, and lists the accepted
  records it could not clear (outside the history of the skill, in a moved skill, or missing) as a warning. If a scan
  holds the lock it erases nothing and says so. A forget that lands
  while a proposal is being prepared stops that proposal, and what it already created for the skill is removed.

### Privacy and spending

- Secrets (provider keys, tokens, bearer headers, `key=value` credentials, URL credentials, private keys) are
  redacted before anything reaches the judge or the store. The store keeps pointers into the session file and short
  redacted summaries, never transcripts. A case whose prompt holds a secret is left out of a bank, never redacted.
- The files are created with mode 0600 and directories 0700.
- At most `judgeCallsPerDay` judge calls per day and one proposal per 24 hours. A proposal, a generated bank and a
  gate each spend model calls or runs, and you approve before the gate is spent.
- Nothing replays unless you listed the skill. A replay is not a sandbox (see below), so the list is yours.

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

The model can run parts of the loop through the `skill_improve` tool, which has five actions:
`diagnose` reads the session and the skill and reports what failed, `propose` stages a candidate,
`gate` measures a candidate that is already in staging, `validate` reads a case bank and reports
its first violation or that the bank is valid, and `record` appends a short note (the `focus`, at most 300 characters) about a
correction to the observer's store as a self-report. `diagnose` and `validate` cost nothing; `record` writes one
line and answers `observe-disabled` when the observer is off; `propose` spends one model call; `gate` spends the
replay budget. `record` never edits a skill, never gates and never accepts. The tool never accepts: only the
command edits a skill.

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
- `staging/observer-banks/<skill>-<hash>/` holds a generated bank until you approve it.
- `state/observe.jsonl` is the observer's log: episodes, judgements, observations, proposals, failed preparations, prompt
  answers, gate outcomes, tombstones and forgets. `state/observe-cursor.json` records which session files were read, and
  `state/observe.lock` exists only while a scan or a forget runs.
- `banks/<skill>.json` holds the case bank of a skill: yours or the one the observer generated.
- `labeling/<timestamp>.jsonl` is what `--scan --dry-run` writes.

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
- The judge is a recorded condition and not a source of truth. It is one model call per case, and it can
  accept a case whose answer does not satisfy the rubric; what keeps a wrong acceptance out is the
  unanimity between the cases, so a bank of one case leans on a single judgement.
- A bank measures the answer, and the replayed turn runs in the working directory of the session. A file
  of that directory that answers the question makes both arms pass and the gate abstains with
  `no-improvement`, because what the case measured was the directory and not the skill.
- A retirement is not undone. There is no `unretire`; the way back is to propose another lesson and
  let it pass its gate.
- A proposal costs one model call even when the gate later cannot run, for example when the bank is
  missing.
- The observer's detection is a heuristic. Implicit attribution (the assistant read a `SKILL.md`) is noisy, and a
  session is read in the order of its file, not along the active branch. Measure it with `--scan --dry-run` before
  trusting it. The dry-run sample is the most recent N episodes, not a random one.
- A bank generated from past episodes is approved by you before it is used, but it is still a guess at what the
  skill should answer. A probation lesson was never measured at all. The gate proves the lesson works on the cases,
  not that the pattern is real.
- `--setup` rewrites `settings.json` as 2-space JSON: the formatting of that file is lost.
- `--forget` removes what carries the name of the skill. A suspicion that was raised and never confirmed names no
  skill, so it stays. A line appended in the instant between the last read of the file and the rename of the rewrite
  (a `--note`, for example) can be lost; the forget takes a lock against scans, not against appends.
- `--forget` leaves the titles and slugs in the `decision.json` of forgotten candidates, does not touch the files of
  `--scan --dry-run`, and does not change staging directories created by older versions (0755/0644). A record in the
  history of a moved or missing skill keeps its text, and the command lists it. Two long distinct lesson titles can map
  to the same slug.
- After a lesson is closed as stale, the same lesson proposed again the same day counts as a failed preparation: the
  pattern waits 24 hours.
- The daily judge budget counts an episode whose judgement keeps failing once, however many times it is retried.
- A note or a self-report joins the latest pattern of the same skill and source, so notes about different corrections of
  one skill add up together.
- The dispatch of `--review` from the background was checked on pi 1.5.2; its behaviour on pi 1.4.0 is untested.

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
