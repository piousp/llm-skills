# Developer notes

Working notes for this package. Not part of the published documentation.

## Layout

| Path | Contents |
|---|---|
| `extensions/index.ts` | Entry point loaded by pi. Stays thin: registers the command and the tool, no logic |
| `src/` | One module per responsibility: config, eligibility, inventory, evidence, diagnosis, frontmatter, proposer, perimeter, writer, messages, command, tool |
| `src/attempts.ts` | The event vocabulary of the index, the reserved names, the attempt hashes and the one constructor of a line |
| `src/case-bank.ts` | The neutral bank of cases: the versioned format, its two profiles and the one reader of the file |
| `src/checks.ts` | The mechanical predicate of the fourth class: the four kinds of check, and the one place a check is executed |
| `src/gate/` | The paired replay gate: execution contracts, expectation evaluator, arm overlays, replay runner, budget, scorer, the two flows, judge, acceptance |
| `schemas/` | Versioned JSON schemas: `decision.json` and the case bank, validated by tests |
| `test/unit/` | Unit tests, `node --test` (type stripping is the Node default from 22.18) |
| `test/fixtures/` | Settings files and skill trees, including symlinks |
| `tmp/` | Local design notes: goal, decisions, plan, review. Gitignored |

`src/gate/`, one responsibility per file:

```
src/gate/
├── types.ts            execution contracts: one replay run, one verdict, the closed reason lists
├── expectation.ts      the reading of one run against the expectation of its item
├── overlay.ts          the two arms of the gate, built inside staging from the skill
├── replay-runner.ts    one `pi` child per run: argv, JSONL parsing, the caps
├── budget.ts           the paired budget: the order of the runs, spent over items or over cases
├── scorer.ts           planGate, planCaseGate, evaluateGate, evaluateCaseGate, the Wilson interval
├── flow.ts             resolve the candidate, preregister, spend the budget, judge, record
├── directional-flow.ts the same over a bank of cases: pin the bank, spend, judge, record
├── judge.ts            the second condition: one model call, read positionally
└── acceptance.ts       the order of the writes that edit an accepted skill
```

The split is the one that keeps the decision auditable: `types.ts` declares shapes and nothing else,
`expectation.ts` and `scorer.ts` are pure over data -- no process, no file, no clock -- so a stored stream
can be re-read and its verdict re-derived, and so is `src/checks.ts`, which is where the fourth class is
executed. `replay-runner.ts` is the only module that starts a process, and `flow.ts` is the only module that
decides to spend. `judge.ts` is a seam and nothing else: the model call arrives as a `CompleteFn`
(`src/proposer.ts`) built by the surface, so no test of that module can reach a provider.
`directional-flow.ts` is a second flow and imports what it shares instead of copying it -- the resolution of
the candidate, the guard of its bytes, the overlay of the two arms, the budget and the layout of the index
line. Nothing outside `src/gate/` imports a module of `src/gate/` except the two surfaces, and the replay
runner is not resolved by the extension factory: opening a runner arms nothing, but the rule is that the gate
decides to run and never the wiring.

## Setup

Node 24 or newer. Dependencies are installed:

```bash
npm install
npm run typecheck
npm test
```

There is no build step: pi loads the extension through jiti, so `.ts` imports resolve directly. The
tsconfig uses `allowImportingTsExtensions` for that reason.

## Dependencies

`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `typebox` are host-provided, so they sit
in `peerDependencies` with `"*"` and are never bundled. `devDependencies` pins them to the versions of
the installed runtime (`1.4.0`, `1.4.0`, `1.3.27`) so typechecking matches the API that actually runs.
`pi-ai` is needed only for the `Usage`, `Model` and `Context` types, which `pi-coding-agent` does not
re-export.

Frontmatter is parsed with `parseFrontmatter` from `pi-coding-agent`; no `yaml` dependency is added.
Serialization is written by hand.

The gate adds no dependency: the child process is `node:child_process`, the streams and hashes are
`node:fs` and `node:crypto`, and the Wilson interval is arithmetic and a table of three normal
quantiles.

## Rules that came out of the design

- A skill is edited by the command alone, after its gate accepted the candidate. The tool can diagnose,
  propose and gate; it can never accept.
- Every write goes through one chokepoint wrapped in `withFileMutationQueue()`, with atomic writes and
  read-back verification. The one exception is the append to the index, below.
- The write perimeter is the realpath of an eligible skill directory plus `staging/` and `state/` under
  the write base, and, for the acceptance, the skill's `lessons/` and `.history/`. Nothing else.
- The write base is `<agent dir>/sri` (`src/write-base.ts`), derived from `getAgentDir()` and never
  from the package root: with `pi install npm:pi-simple-sri` the package lives inside `node_modules`
  and an upgrade would take staging and state with it. Records name paths relative to the base.
- Skills are edited through symlinks when they point at another repository; the extension never runs
  git.
- `state/` and `staging/` are per user, shared by every installation of the package. A base that
  cannot be written is a clean failure, not a fallback, and a base inside a skill directory is refused.
- The index is appended with a single write and no lock file. One line, one `write` on a handle opened
  with `O_APPEND`, verified against the tail of the file instead of against a read of the whole thing.
  The reason is that the append of one line is the only thing that has to be atomic, and `O_APPEND`
  already makes it so: the bytes land at the end of the file as the kernel sees it, so two processes do
  not overwrite each other's line the way a read-modify-write does. A lock file would be machinery
  guarding a race that no longer exists, and an orphaned lock file is a worse failure than the race. The
  in-process queue still wraps the append, so two callers of the writer cannot interleave. A line of the
  index that is cut short is not repaired either: `appendAttemptLine` reads the last byte of the file and
  refuses to append after a tail that does not end with a newline, so every later append of that
  installation fails the same way until somebody opens the index and looks. That is deliberate -- a line
  glued onto a truncated one is an index nobody can parse, and a writer that quietly repaired the file
  would bury the damage instead of reporting it.
- The gate measures copies. Both arms are built inside the candidate directory of staging and the
  replay is pointed at them, so a gate that passes and an acceptance that fails leave the skill exactly
  as it was.
- The sentence that announces the gate is printed before the gate is called and promises the cost in
  tokens with no figure. The number of runs exists only once the gate has planned, and planning happens
  inside the gate, so the warning comes earlier than the number: it says what is about to happen, and
  the figure arrives with the verdict.
- An attempt that found no baseline is a state of the attempt and not a verdict. The record is not touched:
  it keeps `not-run` and the outcome it already carried, the index gains one `no-baseline` line, nothing
  is spent, and the retry is the same candidate through `--staged`. A state invented for it would make
  the retry a decision about a gate that concluded.
- The mechanics of a gate are a necessary condition and never a sufficient one. When a bank declares a
  rubric the judge is the second condition, it is asked only after the rule accepted, and an answer of
  the judge that nobody can read abstains the gate instead of accepting it.

## Order of an acceptance

`acceptCandidate` (`src/gate/acceptance.ts`) is the only code path of the package that writes inside a
skill that is in use, and the order of the writes is part of the contract. Each position exists to stop
the next one:

0. A `SKILL.md` that already references the slug is refused before anything is written. Both arms were
   built from the skill as it stood, so a line that is already there makes them identical in
   `## Lessons` and the gate compared the skill with itself.
1. `SKILL.md` has to hash to the `skillContentHash` the gate preregistered. An edit between the gate and
   the acceptance makes the verdict describe a skill that no longer exists.
2. The snapshot comes first, before any edit: `.history/<timestamp>/{SKILL.md,lessons/}`. A timestamp
   that already exists is refused, because history is never rewritten.
3. The lesson is written and verified against the `contentHash` of the candidate, so the bytes that land
   are the bytes the gate measured.
4. The reference line is added to `## Lessons`, idempotent by slug. If it cannot be added, the lesson is
   withdrawn: a lesson pi cannot reach is inert, and half an acceptance is worse than none.
5. The authoritative record of the acceptance is written into the snapshot, and only after the bytes of
   the skill are verified, so a `.history/<ts>/decision.json` that says `accepted` cannot describe a
   write that did not happen.
6. The `accepted` event is appended to the index with the `historyPath` of that record. This is the line
   that joins `gate-accepted` in the staged record with the write, by `candidateHash`.
7. The reload of the session, at the end of the command handler and not of this protocol: the notice that
   names the two paths is written to the frame that still has a context, then `await ctx.waitForIdle()`, then
   `await ctx.reload()`, then `return`. The idle wait is not defensive -- pi warns and returns without
   reloading while the agent is streaming, and the handler sees no rejection, so a reload without it is lost
   in silence. Nothing runs after the reload, which invalidates the frame. A reload that fails is neither
   reverted nor retried -- a publication has no undo -- and it is reported through a channel that reads no
   member of the context (`src/command-skill-improve.ts:578-596`).

The staged `decision.json` is never rewritten to `accepted`: it keeps the `gate-accepted` the gate
decided, and the index line is what tells the two states apart.

A failed acceptance writes nothing at all: the staged record stays in `gate-accepted`, no line is added
to the index, and the reason the protocol refused (`slug-already-referenced`, `skill-drift`,
`history-exists`, `reference-failed`) reaches the caller with its detail. That is why `outcome.status`
has no member for a failed acceptance: the record has nothing to record.

An acceptance that breaks after step 2 keeps whatever the steps after it already wrote -- the snapshot
in every case, the lesson and the reference line once steps 3 and 4 have landed -- so a skill can end up
with a reachable lesson and no `accepted` line in the index. The record keeps `gate-accepted`, because
that is what the gate decided, and the failure reaches the user as the error that stopped the acceptance,
with the paths in it and nowhere else: what a reader has to compare is the index line against the
snapshot.

### The reload of the session

The two calls are at the end of the command handler, after `acceptCandidate` has returned its answer and the
notice of the acceptance has been written: `await ctx.waitForIdle()` and then `await ctx.reload()`. Order
matters -- a reload while the session is still producing a message is a reload of the wrong state, and pi
warns and returns without reloading instead of rejecting -- and queueing `/reload` is not an alternative,
because it is a TUI command and not an extension command.

Both are members of `SkillImproveContext` (`src/command-skill-improve.ts`), required and not seams of
`SkillImproveDeps`: pi exposes them on the context of a command and not on the context of a tool, and a fake
that left one out would lose the reload with nothing saying so. pi's own command context provides both, so the
contract is a compile-time assertion that the wiring passes a context which can do the two things, and not a
runtime probe. `src/gate/acceptance.ts` has neither the calls nor the context they read; the invariant at the
end of `acceptCandidate` records why the step is not there.

## Order of a directional gate

The bank base shares the acceptance, so what it owns is the order that leads to it, in
`src/gate/directional-flow.ts`:

1. Resolve the candidate and refuse one of the other basis (`basis-mismatch`) or one the gate already
   answered (`already-concluded`). Both are refusals: nothing was spent and nothing can be.
2. Read the bank once, under the profile of the invocation, and parse those bytes. A bank that is not a
   baseline is `no-baseline`: one line of the index, zero runs, no byte of the record touched.
3. Re-verify the lesson on disk against the hashes the record declares. A candidate whose bytes moved
   abstains and writes nothing at all.
4. Plan the design, the rule and the floor over the first three cases (`planCaseGate`).
5. Copy the bank into the candidate and read the copy back, so the digest the preregistration pins names a
   file that is there.
6. Preregister the moment, the design, the rule, the floor and the materials of the bank -- before the first
   run, which is the whole point of the exercise.
7. Build the two arms with the overlay of the replay base, and add the digest of the `SKILL.md` they were
   copied from to the same preregistration.
8. Spend the paired budget, case then repetition then arm, judging every run with the checks of its case.
9. Apply the rule, and ask the judge only when the rule accepted and the bank announced a judgement clause.
10. Rewrite the record with the verdict, the tokens of every component and the moment it decided.
11. Write one line of the index -- `gate-rejected` or `gate-abstained`, never `gate-accepted` -- and no byte
    inside the skill.

Why the mechanics are necessary and never sufficient: the judge never sees the incumbent, so it compares
nothing and cannot tell a candidate from the skill it would replace. The rule does that comparison; the judge
says whether an answer the rule already preferred meets the criterion the user wrote, and that conjunction is
the scorer's (`evaluateCaseGate`) and not the flow's. Three consequences follow, and each is a decision:

- A refusal of the rule is never sent to the judge. Asking a model to confirm a comparison that already
  failed would be paying twice to learn nothing.
- A judge that answers `FAIL` rejects (`judge-failed`) and a judge nobody could read abstains
  (`judge-unavailable`). The first is evidence against the lesson; the second is a condition the gate
  announced and could not apply, and it is not evidence of anything.
- A clause that exists and an answer of `not-run` fails closed: the flow refuses to run a gate that announces
  a second condition without the call that would answer it, so a caller cannot discover the missing seam
  twelve runs later.

## Extending the artifacts

Four artifacts outlive the version that wrote them: the index, the `gate` block of a decision record, the
schema as a whole and the bank of cases. Each has one written rule.

### The event vocabulary of the index

- `ATTEMPT_EVENTS` (`src/attempts.ts`) is the single list of events this version may emit, derived to a
  type with `as const`, the same way `LESSON_STATUSES` is.
- **A new event is an entry in that list, never a change to the shape of a line.** Every field a line
  gains is additive and optional, except `failureSignature`, which is required and nullable on purpose:
  a field that is there and says "no failure" is an answer a reader can act on, and an absent field is a
  reader guessing.
- **No reader may fail on an event it does not know.** A reader groups by `candidateHash` and leaves an
  `event` it cannot name alone. `isKnownAttemptEvent()` is the reader-side predicate; `isAttemptEvent()`
  is the writer-side one, and they are deliberately not the same list.
- `RESERVED_ATTEMPT_EVENTS` holds the names this version recognizes and does not emit. It is empty today:
  `no-baseline` was its only member and M1c emits it, because the gate of the case-bank base that finds no
  bank to measure against writes that line, leaves the candidate staged and leaves the record as it was.
  The list and the two predicates survive the emptiness, because the rule they enforce is not about the
  names in it: recognizing a name and emitting it are two different permissions, and the next name a reader
  has to classify lands here before a writer may use it. `ReservedAttemptEvent` is `never` while the list is
  empty, which is what makes `KnownAttemptEvent` equal `AttemptEvent` without either of them being
  rewritten.
- `reason` is the optional field that says what an abstention was about, in the words of the vocabulary
  plus the detail the flow computed: `overlay-failed: cannot copy ...`. It is absent when the reason is
  the whole story, so a line written by an older version and a line written today read the same way.
- M1 does not emit `gate-accepted`: a gate that passes writes no line, and the line of an accepted
  candidate is the `accepted` event the acceptance writes when it edits the skill. The intermediate
  state lives in `decision.json`, where it cannot be confused with the record of a write. The base of the
  bank follows the same rule: a gate that passes is `gate-accepted` in the record and no line of its own.

### The gate block

- `gate.basis` names how the gate decided: `replay`, over the turns of a diagnosis, or `case-bank`, over the
  cases of a file the user wrote. `status` alone no longer names a variant, because the two bases share the
  three states; from M1c on `basis` is the discriminator, and every switch and `assertNever` over the block
  lists the six variants it declares, so a dispatch that forgot a basis stops compiling instead of guessing.
- Every detail that depends on the basis lives under a key named after it: `gate.replay` and
  `gate.caseBank`. The top-level fields (`basis`, `status`, `budget`, `tokens`, `preregistration`) are
  neutral to the basis: `budget` is runs, `tokens` is spend, and `preregistration` is "what was written down
  before the first run". Two members of the preregistration follow the same rule from opposite sides:
  `preregistration.caseBank` is the detail that depends on the basis -- the path the bank was read from, the
  digest of its bytes, the copy that travels with the candidate, the count of cases and the digest of the
  rubric -- and `preregistration.skillContentHash` is the one that is neutral to it. Both bases write that
  hash and the acceptance reads it there, because the result block of the other basis is `null` in the base
  of the bank. `tokens` gains a `judge` component when the bank announced a judgement clause, and `total`
  stays the sum of the components present: three of them in the replay base, four in a judged bank.
- The three states of the case-bank block are the same three words as the replay base: `not-run` with
  `caseBank: null`, which is a candidate proposed with a bank and not gated yet and the state a
  `no-baseline` answer leaves untouched; `preregistered` with `caseBank: null`, which is the bank copied and
  pinned before the first run; and one of the three verdicts with the result under `caseBank` -- the moment it
  decided, the verdict and its reason, one entry per case with the runs of both arms, the tallies, the
  interval, the count of regressions, the block of the judge and the overlays the acceptance compares against
  the skill.
- The key of the other basis is `null` in the three states of the case-bank base and absent from the blocks
  of the replay base. The schema cannot tie either key to the value of `basis` -- `replay` is required of
  every block under `@1` -- so what keeps a record from describing both bases is the writer: each flow writes
  only its own key, and a suite per basis pins it.
- In types, `GateBlock` is a union of the states of one gate, and every switch and `assertNever` over it
  lists the places that have to learn about a new basis instead of letting one of them guess.

### The schema version

`decision@1` moves only additively:

- adding an optional key,
- widening an enum,
- adding a branch under `gate` named after a new basis.

Any of those three keeps every record written before it valid. A change of the shape or of the meaning
of a field already written under `@1` is `decision@2`, with a new `$id`, and the package then writes one
schema and reads one schema.

The reason the rule is drawn this tightly is that `additionalProperties: false` is set on every object
of the schema: a key added without a schema change is a record no reader validates, and
`test/unit/decision-schema.test.ts` keeps a negative case for an unknown key under `gate` so that
extending the record stays a decision and not a hole. That suite also proves a record written by this
version validates, and that `outcome.status` cannot disagree with `gate.status`
(`outcomeStatusFor()` in `src/types.ts` is the only mapping between them).

M1c added to `@1`, and all of it is one of the three moves above: the fourth evidence class and the `origin`
of a defect, `checks` and the fourth `expectation.class`, `gate.basis` widened from a `const` to an enum,
`gate.caseBank` and `gate.preregistration.caseBank`, `gate.preregistration.threshold.judge`,
`gate.preregistration.skillContentHash`, `gate.tokens.judge`, and `checkFailures` on a run of a bank. The bank
itself is not a change of this schema: it is a second file with its own `$id` and its own `format`.

One change sits on the edge of the rule, and it is the only one: `diagnosis.replayItems.minItems` went from
`1` to `0`. Relaxing a constraint invalidates no record written before it, and the meaning of the field does
not change -- it is still the turns the attempt replays. What the relaxation buys is the directional attempt,
which replays the cases of a bank and therefore replays no turn of the session: its diagnosis is the ask, so
an empty list there is its correct value and not an empty result. The guard did not move into the schema and
did not disappear: it became a property of the basis, one constructor per basis -- `buildDiagnosis` refuses an
empty diagnosis of the transcript, `buildBaselineDiagnosis` and `buildDefectDiagnosis` build the other two --
so no record is judged by the guard of another basis. `decision@2` was considered for this relaxation and
rejected: it would have split the schema in two for a keyword that only widens.

A candidate staged under an older schema is refused, not migrated: `resolveStagedCandidate` reads one
schema and reports `unsupported-schema` for anything else, because a record half of each version would
be written by a gate that could not tell what the fields mean.

### The bank of cases

The bank is the fourth artifact that outlives the version that wrote it, and it is a file of its own:
`schemas/case-bank.schema.json`, `$id` `https://pi.dev/schemas/pi-simple-sri/case-bank@1.json`, versioned by
its `format` const `pi-simple-sri/case-bank@1`. The rule of `decision@1` applies to it whole: a change of the
shape or of the meaning of a field already declared is a new format with a new const, and `src/case-bank.ts`
refuses a bank of another version instead of reading it as this one with fields missing.

- **One format, two profiles, and the profile is an argument.** `baseline` may declare the `rubric`, `origin`
  requires an `origin` and forbids a `rubric`. The file carries no discriminator, because a bank that is not
  there still has to be read as one of the two, so the caller states the profile it already knows: that is
  why a missing bank means `no-baseline` on one branch and `no-evidence` on the other.
- **The limitation is written in both files.** JSON Schema cannot tie the presence of one property to the
  value of another without `if`/`then`/`oneOf`, and the published shape stays flat on purpose: the schema
  declares the limit of every field and `src/case-bank.ts` is the authority on which profile accepts which
  fields. `test/unit/case-bank.test.ts` reads the same fixtures with both readers, which is what keeps the
  publication and the validator from drifting.
- **The same rule applies one level down, to a check.** Which of `value` and `pattern` a check needs follows
  from its `kind`, the schema ties no property to another, so `validateCheck` (`src/checks.ts`) refuses the
  pair and `evaluateChecks` is the one place a check runs. A pattern is compiled when the bank is read, so a
  broken one is refused before a run is spent and never discovered mid-replay.
- **Absence is a value.** The reader answers `absent`, `unreadable`, `too-large`, `not-json` or `invalid`, and
  `caseBankReason` turns that into the stable text a `reason` carries: `bank-absent: <path>`,
  `bank-invalid: <first violation>`. `absent` is not a problem with the file: it is the answer of a branch
  whose base does not exist yet.
- **The caps are the schema's, and they are counted in code points**: 1 MiB of bytes before parsing, fifty
  cases with two as the floor, 8 000 characters of rubric, 4 000 of prompt, 500 of description and of the text
  of a check, 200 of the excerpt. The one rule JSON Schema has no keyword for -- two cases cannot share an id
  -- lives in the validator, with the message pointing at the second occurrence.
- **The reader resolves nothing.** `origin.path` travels as it was written; the branch that reads a defect
  resolves it against the working directory of the invocation, hashes the bytes and records the resolved
  path, and the gate re-reads that path before it spends (`origin-moved`).

The reader hands back the bytes it parsed next to the data (`LoadedCaseBank`), because a preregistration that
re-read the path could pin a file the runs were not about. One read, one parse, one digest.

### The expectation and its class

- Two relations between an expectation and its class are not in the schema, because it ties no property to
  another: `tool` is present exactly on the two tool classes, and `checks` is present and non-empty exactly
  on `quality_defect`. `expectationViolation` (`src/diagnosis.ts`) owns both, and
  `test/unit/diagnosis.test.ts` walks the whole product of class, tool and checks instead of a sample of it.
- Every writer satisfies it: `expectationFor` answers `{class, version}` for a class that needs no tool and
  adds `tool` only to the two that do, and the checks of a defect arrive with the bank, in
  `buildDefectDiagnosis`.
- Two functions stay total over shapes this package does not write, and that is deliberate:
  `describeExpectation` answers a sentence for any expectation, because a record read from disk has to be
  describable whether or not it is well formed, and `isIntrinsicFailure` reads a `tool` that a correction does
  not have. A test that builds a `user_correction` with a `tool` is therefore exercising that totality and not
  a shape written by this version: the invariant is the rule, the sentence is derivable for a malformed record
  too, and the schema declares `tool` and `checks` as optional keys of any class, so the invariant is not a
  validation a foreign record has to pass either. It is what the writers obey.
- The guard of an empty diagnosis follows the same split: `buildDiagnosis` still refuses a diagnosis with no
  replay item and the schema no longer does, because how many items are right is a property of the basis and
  each constructor owns its own answer.

## Tests

The suites under `test/unit/` never start a process, touch the network or read a real skill. The gate
is driven end to end with a fake `runReplay`, a fake clock and a skill fixture in `mkdtemp`; the replay
runner is driven with a fake child, and `buildReplayArgs` is asserted as data, so the argv is checked
without `pi` existing. The bank base is driven the same way, with a fake judge, and `createModelCall` is only
ever handed a stub registry whose single method is a fake: no test builds a provider, a credential or a real
`ModelRegistry`.
