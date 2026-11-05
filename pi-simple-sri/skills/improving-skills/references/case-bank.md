# The case bank

The package never authors a bank: the user writes it, and the gate writes a copy of the file next to the candidate
it measures, named `case-bank.json`, so the cases that were run travel with the candidate. A bank is one JSON object
in a file, and it measures a skill when the invocation names it. The command spells that as `--bank=<path>` for a
directional improvement, whose cases are the questions to answer, and as `--bank=<path> --defect` for a defect an
artifact shows; the tool receives the same material as the fields `bankPath` and `defect`.

## The shape of a bank

A bank is one JSON object, and every level of it is closed:

- The root carries `format` with the version of the contract, an optional `description` for humans, an optional
  `rubric`, an optional `origin`, and `cases`. A misspelled field is refused by name instead of being dropped.
- The file declares no profile. The invocation chooses one, and the two readings differ in two fields: `baseline`
  may declare the `rubric` the judge applies to every case and forbids `origin`, while `origin` requires `origin`
  with its `kind`, its `path` and its `excerpt`, and forbids `rubric`. The reason is that a defect has a truth the
  artifact already shows, and a rubric there would leave the judge deciding something the artifact says.
- A case carries `id`, `prompt` and `checks`. The `id` is a slug and unique in the bank, because it is the
  coordinate a failure names. The `prompt` is the question the replay sends.
- A check is one of four kinds: `contains` and `not-contains` compare a literal substring with `value`,
  case-sensitively; `regex` and `not-regex` match `pattern` with `flags` of `""` or `"i"`. Every check of a case has
  to pass. An OR is two cases, because the rule of the gate is unanimity between cases.
- At most three cases of a bank are measured, in the order of the file.

The limits are read from the schema rather than restated from memory: `../../../schemas/case-bank.schema.json`
declares the limit of every field and of every text, and the range of cases. The cap on the bytes of the whole file
is not in the schema, because it is a fact of the reader: it lives in `../../../src/case-bank.ts`, which is the
validator that reads a bank before any run is spent. A limit quoted at second hand is the copy that goes stale first.

Two templates are the worked example, one per profile, each of them a valid bank as it stands:

- `../assets/case-bank.baseline.json` for a bank of profile `baseline`.
- `../assets/case-bank.origin.json` for a bank of profile `origin`, with its `origin` block.

Neither template declares a `rubric`: a rubric obliges the judge on every copy of the bank, so it belongs in the
bank the user writes when the checks alone cannot say what a passing answer looks like.

## Checking a draft

`validate` is the reader of the format exposed as an action, so it is the first thing to run on a bank, and it is
the cheapest way to find out whether a file is a bank at all. It takes the `bankPath` and reads it under the profile
that `defect` selects: `baseline` when `defect` is absent or false, `origin` when it is true. It answers `bank-valid`
with the number of cases and the profile, or `bank-refused` with the first violation of the file in the same words
the gate would use: `bank-absent: <path>`, `bank-unreadable: <path>: <error>`, `bank-too-large: <size> bytes, over
the <cap> byte limit`, `bank-not-json: <reason>` or `bank-invalid: <first violation>`.

It reports one violation, not all of them, because the reader stops at the first: a bank whose `format` is wrong is
not a bank with two bad cases. It spends nothing, writes nothing and leaves the file exactly as it found it. It does
not repair a bank either, and neither does any other action. The artifact a defect came from is not checked here:
`validate` reads the bank and nothing else, and the `no-evidence` of `propose` names a path that points at nothing.

The cycle is write, validate, correct, and it costs nothing to repeat: the file is written, `validate` is called,
the one thing the answer names is fixed, and the call is made again. The reason to run it is that a baseline bank
the gate cannot read is a bank that costs the proposal before anyone learns it is unreadable, while the bank of a
defect is read before the generation and a typo there costs nothing but the round itself.

## Writing the cases with the user

No case reaches a file unless the user has confirmed it in a numbered round of the conversation: that is the
invariant of this section, and it holds for every case of every bank.

The facts come before the first round, because a fact the model can read is not a question for the user: the limits
the schema declares, the `SKILL.md` of the skill that is going to be measured, and both templates, since the profile
depends on the branch and the branch is the user's decision in the first round.

The design tree lives in the scratch of the conversation and not on disk. Each decision opens the ones that hang
from it, and no file is written until the interview closes.

A round holds every decision whose prerequisites are already resolved, and that set is what a round is. The round
numbers its questions, carries one recommendation per question, and then waits. One question at a time is not a
round, and neither is a question whose prerequisite is still open.

The user decides the branch, which is either a direction to measure or a defect an artifact shows; the `prompt` of
each case, in the user's words; the condition that makes an answer pass, also in the user's words; how many cases
the bank carries, which is at least two and within the cap the schema declares; whether a rubric is needed and what
it says; for a defect, which artifact and where its path points; and where the file is going to live.

The model decides the spelling of an `id`, which kind of check expresses the condition, the order of the keys and
the shape of the JSON. A recommendation may carry a draft, and a draft is not a case until the user confirms it.

The interview closes when the frontier is empty and nothing was assumed in silence, and the close is a numbered
round like any other: the synthesis presents the branch, every case with its condition and the path, and it carries
one recommendation, which is to write the file. The file is written only after that round is answered, with the file
tools of the session.

Then `validate` runs, one violation is fixed at a time, and the cycle repeats until the answer is `bank-valid`. At
that point the answer is the exact command line and nothing else, because the gate belongs to the user. The usual
case has no candidate yet, so the line is `/skill-improve <skill> --bank=<path>`, which proposes and gates in one
run; the same line with `--defect` measures a defect an artifact shows; and a candidate that already exists enters
the gate again with `/skill-improve <skill> --bank=<path> --staged=<stagingPath>`.
