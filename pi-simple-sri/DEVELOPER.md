# Developer notes

Working notes for this package. Not part of the published documentation.

## Layout

| Path | Contents |
|---|---|
| `extensions/index.ts` | Entry point loaded by pi. Stays thin: registers the command and the tool, no logic |
| `src/` | One module per responsibility: config, eligibility, inventory, evidence, diagnosis, frontmatter, proposer, perimeter, writer, ledger, metrics, standing, retirement, signals, messages, command, tool |
| `src/attempts.ts` | The event vocabulary of the index, the reserved names, the attempt hashes and the one constructor of a line |
| `src/case-bank.ts` | The neutral bank of cases: the versioned format, its two profiles and the one reader of the file |
| `src/checks.ts` | The mechanical predicate of the fourth class: the four kinds of check, and the one place a check is executed |
| `src/gate/` | The paired replay gate: execution contracts, expectation evaluator, arm overlays, replay runner, budget, scorer, the two flows, judge, acceptance |
| `src/observe/` | The observer: deferred detection of corrections across sessions, the store, the patterns, the proposal and the review. See [The observer](#the-observer) |
| `src/skill-block.ts` | `splitSkillBlock`: the one place a `<skill>` block is told apart from what the user typed |
| `src/json-reply.ts` | The shared reading of a model reply that has to hold one JSON object (`firstObjectWhere`, `scanObjects`): used by the proposer, the observer's judge, the bank generator and `--setup` |
| `scripts/` | `score-labels.ts`, run by hand over the labeling files of a dry-run. Not published, not covered by `tsconfig` |
| `src/vitality.ts` | The force of an accepted lesson: the event the acceptance writes, and the two predicates the rule of retirement is made of, shared by the metrics and the check of an accepted lesson |
| `schemas/` | Versioned JSON schemas: `decision.json`, the case bank, `retirement.json` and the lines of `signals.jsonl`, validated by tests |
| `skills/` | The skill this package publishes: the manual, its `references/` and the two case-bank templates. Ships in the tarball because `files` names it, and pi discovers it because `pi.skills` declares it |
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
  propose, gate and validate; it can never accept.
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
  would bury the damage instead of reporting it. The one lock of the package, `state/observe.lock`, is not an
  exception to this reasoning: it guards a scan and a forget, which read a whole file and write it back, and no
  append ever takes it ([The observer](#the-observer)).
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
- The closed set of lesson states is the contract, and `retired` has its writer since M3. `retired` is a
  member of `LESSON_STATUSES` (`src/types.ts:161`), which M2 declared with the state and with nothing that
  produced it; the retirement writes it (`retireLessonFile`, `src/writer.ts:628`, called by step 4 of
  `retireLesson`, `src/retirement.ts:145`). The state stays in the set for the reason it was declared there:
  a state removed from it is a validator that refuses the lesson the next version writes.
- A lesson accepted before M2 keeps the frontmatter it was written with -- `status: "proposed"` and
  `gate: "pending"` -- and is not migrated: rewriting it would edit a skill with no gate in front of it,
  which is the one thing this package does not do. The validator accepts it exactly as it accepts a lesson of
  today (`src/lesson-frontmatter.ts:7-8`, status at `:166-168`, gate at `:179-181`), and `accepted@<ts>` stays
  a valid gate value for a file already on disk (`src/types.ts:178-180`).
- The floor of a paired design is two items, and equivalent failures are one. `MIN_ITEMS = 2`
  (`src/gate/scorer.ts:56`) abstains with `insufficient-items` when the plan is short -- `:89` for the replay
  base, `:179` for a bank -- and the item count that reaches it is already deduplicated:
  `equivalentFailureKey` (`src/diagnosis.ts:343-348`) keys a failure by its class, by the tool or the digest
  of the checks it watches, and by its arguments, or by its prompt when the arguments were not recorded. The
  two constructors that build items apply it (`selectReplayable`, `:316`, and `buildDefectDiagnosis`, `:234`),
  and the effect has to be expected instead of discovered: two identical `bash` orders are one task, so they
  leave one item, one item is under the floor, and the attempt abstains with `insufficient-items` instead of
  comparing a run against itself (`:226-230` states it where the dedupe happens).
- The label `(M2)` names two different milestones, and no label is renamed. In `src/lesson-frontmatter.ts`
  (`:7`, `:31`, `:50`, `:79`, `:143`) and in `src/types.ts` (`:158`, `:164`) it names M2 as the milestone of
  the **frontmatter format of a lesson**; in `extensions/index.ts:121` and `src/command-skill-improve.ts`
  (`:139`, `:143`) it names M2 as the milestone of **this reload**. The labels that carry a slice next to the
  milestone -- `(M2, S5)` and `(M2, S7)` in `src/diagnosis.ts:449`, `src/checks.ts:51`, `src/gate/flow.ts:122`,
  `:184`, `:1037` and `src/gate/expectation.ts:36`, `:108`, `:146`, `:173` -- name the milestone whose slice
  changed the code beside them. A rename would touch a dozen comments and change no line of behaviour; what
  the next reader needs is to know that the words point at different things, and that is this bullet.
- The label `(M2c)` carries neither of those two meanings, and it is not a rename of them. It names the
  skill the package publishes (`skills/improving-skills`, `PUBLISHED_SKILL_NAME` in `src/names.ts:41`) and
  the fourth action, `validate`, with the two outcomes it answers -- `src/eligibility.ts:17`,
  `src/tool-skill-improve.ts:144-146` and `src/messages.ts:80` -- and `(M2)` keeps its own two meanings
  instead of being stretched to cover these.
- The manual in `skills/improving-skills` is part of the surface of this package: a change to the union of
  actions, to an outcome of `src/tool-skill-improve.ts`, to the abstention vocabulary of `src/gate/types.ts`
  or to the budget of `src/gate/scorer.ts` updates it in the same slice. Four tests hold the closed
  vocabularies (`ACTION_NAMES`, `OUTCOME_NAMES`, `ABSTENTION_REASONS` and `VERDICT_REASONS` in
  `test/unit/package-skill.test.ts`); the numbers are prose and nothing catches them automatically.

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
   member of the context (`src/command-skill-improve.ts:1149-1163`).

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

**Eligibility is read once per run and checked twice.** The settings of a run are read in the branch that runs, and
once (`readSriConfigOf`, `src/config.ts:108`); the value travels as data to the loop that builds the inventory, to
the request of the gate and to the acceptance. The two places that decide something irreversible take the same
verdict with the one rule of `src/eligibility.ts` (`eligibilityOfSkill`, `:59`): the gate before it spends a run
(`eligibilityRefusalOf`, `src/gate/flow.ts:162`) and the acceptance before it snapshots anything
(`src/command-skill-improve.ts:1016`). The trade is written down: an edit of `settings.json` in the middle of a
long gate is seen by the next run and not by the one in flight, which is what a run that decides on one
`SriConfig` from its proposal to its write costs.

### The two hashes of a lesson

`lessonHashes` (`src/writer.ts:99-112`) computes the pair from the one input that defines a candidate, the
lesson text as it will be written. `contentHash` covers the whole file; `bodyHash` covers the body after
`normalizeBody` (`src/writer.ts:850-852`), which trims it and collapses every run of whitespace into one
space. **A change of frontmatter therefore leaves `bodyHash` identical and moves `contentHash`**, and two
lessons with the same body under different dates share the body hash. The `accepted` line of the index
carries both (`src/types.ts:694`, the pair at `:697-698`), and `bodyHash` is the join between the index and
the disk: the acceptance writes `candidateHash` with the hash step 3 verified against the bytes it published
(`src/gate/acceptance.ts:236-246`), so that line names the file the skill now holds.

**What is measured is what lands.** The candidate is serialized with the frontmatter it will have inside the
skill, `status: "accepted"` and `gate: "accepted"` (`src/proposer.ts:191-199`), so the candidate arm of the
gate, the `contentHash` of the record and the published file are the same text, and nothing composes it a
second time. The consequence is accepted and it is worth naming: a candidate the gate **rejects** stays in
`staging/` under a frontmatter that says `accepted`. The verdict of an attempt lives in `outcome.status` and
in the index, never in the frontmatter of a lesson, and `staging/` is not inside any skill.

**And nobody reads that frontmatter as a verdict.** The verification at retrieval -- the check of M3 over
skills that are already accepted -- reads `decision.json` and `state/attempts.jsonl`, never `lesson.status` nor
`lesson.gate`: the module says so in its own first lines (`src/standing.ts:19`), and the section
[The check of an accepted lesson](#the-check-of-an-accepted-lesson) states it with the test that fixes it. No
module of `src/` reads the two fields to decide anything: `src/lesson-frontmatter.ts` serializes them (`:101`,
`:103`, `:131`, `:133`) and validates them (`:166-168`, `:179-181`), and that is all. The limit is written here
as a permanent constraint and not as a note about this version.

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

Six artifacts outlive the version that wrote them: the index, the `gate` block of a decision record, the
schema as a whole, the bank of cases, the record of a retirement and the file of the suspicions. Each has one
written rule.

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
- **`retired` is emitted, not reserved** (M3, S4). The line a lesson leaves when it stops applying is written by
  the retirement (`retireLesson`, `src/retirement.ts:145`), it is an entry of `ATTEMPT_EVENTS`
  (`src/attempts.ts:49`), and it carries the pair of hashes of the acceptance plus `failureSignature: null`, so
  it joins its `accepted` line by `candidateHash` exactly the way that line joined the `proposed` of the run
  that produced it. Nothing of M3 passed through `RESERVED_ATTEMPT_EVENTS`: a name is reserved by a version
  that recognizes it and does not write it, and `retired` arrived in the slice that writes it.
- `reason` is the optional field that says what an abstention was about, in the words of the vocabulary
  plus the detail the flow computed: `overlay-failed: cannot copy ...`. It is absent when the reason is
  the whole story, so a line written by an older version and a line written today read the same way.
- M1 does not emit `gate-accepted`: a gate that passes writes no line, and the line of an accepted
  candidate is the `accepted` event the acceptance writes when it edits the skill. The intermediate
  state lives in `decision.json`, where it cannot be confused with the record of a write. The base of the
  bank follows the same rule: a gate that passes is `gate-accepted` in the record and no line of its own.

### The book of attempts

`readLedger` (`src/ledger.ts:76`) is the only reader of `state/attempts.jsonl` and of the `decision.json` each
of its lines names. It exists because the criterion of M3 is a count: until this slice the index had three
writers and no reader at all, and a series of sessions nobody can read is a series nobody can measure.

- **The type of the writer is not the type of the reader** (`src/ledger.ts:17`). `AttemptLine.event` is
  `KnownAttemptEvent` because only `buildAttemptLine` decides what this version emits, and a line read here may
  carry an event a later version wrote. So `event` is a `string` in `ReadAttemptLine` (`:52`), an unknown event
  is kept verbatim and counted like any other line (`src/metrics.ts:135`, under the key `unknown`), and nothing
  in this module normalizes or rewrites what it read. `isKnownAttemptEvent` (`src/attempts.ts:75`) is the
  predicate a consumer classifies a line with; the reader itself classifies nothing, which is why an old report
  and a new index never disagree about a line neither of them understands.
- **What it does with what it cannot interpret** (`:24`). A line that is not JSON, that is not an object, or
  whose `event` is not a non-empty string stops the reading where it is, and `damaged` names the position and
  the problem (`:66`, `:97`); the lines before it are answered. A file of one object per line has no way back
  from its first illegible one -- the truncated tail of an interrupted append is exactly that line, and
  whatever follows it addresses no event either -- so the alternative is a report with a silent gap, which
  reads as a smaller series.
- **A record is an annex of a line** (`:140`, `:164`). `historyPath` is what an accepted line names and
  `decisionPath` is what the rest of the vocabulary names, both relative to the base of the run; a record that
  is absent, that is not JSON, that is not an object, that declares another schema or that lost a field of its
  spine is the `problem` of the line and never an exception (`:208`, `:230`, `:182`). The attempt happened
  whether or not its record survived the `staging/` directory it was written in, and the coverage of a report
  counts the difference instead of hiding it.
- **An absent index is an empty answer** (`:84`): a package just installed has no attempts, so a caller asking
  for the series of a machine that never ran one deserves `lines: []` and not an exception. Any other failure
  of this read is the state of the machine and travels as it is.
- **It never writes** (`:29`): no `mkdir`, no `writeFile`, no rename and no `rm`. Reading is not a privilege
  that has to be defended, so the module has no perimeter and no mutation queue, and the base is resolved with
  `path.resolve` instead of being required absolute the way the chokepoint requires it.

**The limit, and it is deliberate.** The reader validates two things and nothing else: the version of
`decision.json` (`:230`), compared against the literal `src/types.ts` owns, and the spine of the record -- the
fields its three consumers dereference, which `recordProblemOf` checks one by one (`:182`). The spine is
`skill.realDir`, the four strings of `candidate`, `evidence`, `outcome.status` and `gate.status` with
`gate.basis`, and a record that lost any of them is the `problem` of its line exactly like a record that is not
there: it is not counted, the reading of the next line goes on, and the consumers answer instead of raising.
What stays out is the rest of `decision@1`: a `gate.caseBank` without `cases` passes the guard and is the
problem of the consumer that reads it, because validating the whole document here would be a second
implementation of the schema at run time. That partition is the one the module comment states: the whole shape
of a record is the business of the gate (`readStagedDecision`, `src/gate/flow.ts:1009`), which this module does
not import, and a second reading of that contract here would be a second implementation of a rule with an owner
-- one that could disagree with the gate and would have to be maintained beside it.

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

**The literal has one owner.** `pi-simple-sri/decision@1` is declared once, beside the type that names it
(`src/types.ts:196`, the type at `:188`), and the three modules that compare it import the constant instead of
spelling it again: the reader of the index (`src/ledger.ts:4`), the gate (`src/gate/flow.ts:10`) and the builder
of the record (`src/improve-flow.ts:20`). Until M3c the literal was written four times -- three copies beside the
type, two of them typed `DecisionSchema` so that a `@2` broke them at compile time -- and three copies are three
things a change has to visit by hand. What witnesses the version now is not a copy in the code but the artefacts
outside it: the `const` of the schema (`schemas/decision.schema.json:10`), and the tests, which keep the literal
written by hand on purpose, because a test that imported `DECISION_SCHEMA` would follow a `@2` instead of
refusing it (`test/unit/ledger.test.ts:22`, `test/unit/metrics.test.ts:31`, `test/unit/standing.test.ts:39`).

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
- **The adapter of an eval set is not in the package, and the reason is measured.** A reader of
  `evals/prompt_set.json` was the contingent slice of M2, gated on at least three of the author's files
  sharing one of two shapes: `{cases: [{prompt}]}` or `[string]`. Neither shape occurs. Of the eight files of
  `/home/pablo/LLMs/skills/*/evals/` and `~/.pi/agent/evals/`, the seven that parse are an array of objects
  carrying `id`, `prompt` and `expected_checks` -- plus `should_trigger` in most, and `seed` and `ctx` in two
  -- and `pablo-code-philosophy` is not valid JSON at all (`Invalid \escape`, line 45). And the field that
  would carry the predicates is not one: `expected_checks` names the checks of the author's own harness --
  Python functions of a registry (`~/.pi/agent/evals/check_registry.py:275`), parameterized names such as
  `mentions_keywords:yagni|kiss`, and in some sets a rubric a judge applies -- and not the `CaseCheck`
  predicates a bank carries. A bank built by reading `prompt` alone would hold cases with no `checks`, and
  `buildDefectDiagnosis` drops every case without a predicate (`src/diagnosis.ts:231`), so the gate would
  abstain with `insufficient-items` every time: it would be a bank that costs a proposal and measures nothing.

The reader hands back the bytes it parsed next to the data (`LoadedCaseBank`), because a preregistration that
re-read the path could pin a file the runs were not about. One read, one parse, one digest.

**The limits have one owner and the format has one worked example.** The caps of a bank are the schema's,
declared in `schemas/case-bank.schema.json` and nowhere else, so a limit that only the reader knew would be a
limit the publication never states. The two templates of `skills/improving-skills/assets/` are the only worked
example of the format, and the suite reads them with the same two readers the gate reads a bank with -- the
schema and `loadCaseBank` (`test/unit/package-skill.test.ts`) -- so an example the package would refuse fails
there instead of shipping in the tarball.

#### The adapter of an eval set

The gate that would have admitted a reader of `evals/prompt_set.json` never opened, and the bullet above states
the argument: what belongs here is the count it was decided on, because that is the part a reader can check
against the tree. Nine `evals/` directories under `/home/pablo/LLMs/skills/`; eight `prompt_set.json` between
those directories and `~/.pi/agent/evals/`; and **not one file under the nine** with either of the two shapes
the slice was gated on. Seven of the eight parse, and what they hold is the author's own harness -- an array of
objects carrying an `id`, a `prompt` and the names of `expected_checks` -- while the eighth,
`pablo-code-philosophy`, is not JSON at all: line 45 escapes `\s` inside the name of a check
(`kiss\s*>\s*dry`), which JSON does not define.

Zero of nine is the shape of the answer, and the contract of the bank is what makes it final. A case requires
`checks` with `minItems: 1` in both profiles, one definition because the file carries no discriminator
(`schemas/case-bank.schema.json:52`, `:66-69`), and the reader refuses an empty list under the same rule
(`src/case-bank.ts:362-367`). An adapter that read `prompt` alone would therefore produce cases with no
predicate, `buildDefectDiagnosis` drops every one of them (`src/diagnosis.ts:231`), and the gate would
abstain with `insufficient-items` every time: a bank that costs a proposal and measures nothing. A foreign
format is not uncomfortable here; it is short of the information this package measures with.

**What would reopen it.** A second consumer whose predicates are already `CaseCheck` -- not the names of a
registry of another repository -- or an evaluation file that declares its own checks. Either one arrives as one
more producer of a `CaseBank`, and the plug point does not move: `loadCaseBank(file, profile)`
(`src/case-bank.ts:148-151`) stays the only entry point to the format, `readCaseBank` behind it the one parse,
and no adapter changes the format, the profile or the flow.

The slice stayed closed, and the pending item it left behind was dropped on 2026-11-06: the adapter is not a debt
to pay later. What stands is the condition above, which is a trigger and not a task -- a second consumer arriving
with `CaseCheck` predicates opens the work again, and nothing else does.

### The expectation and its class

- The relation between an expectation and its class is stated three times, and the three say the same
  thing: `Expectation` is a union in `src/types.ts:123-126`, one branch per family of `KIND_RULES` -- `tool`
  required on exactly the two tool classes, `checks` on the defect, neither on the correction --; the schema
  declares the field with `oneOf` and a `required` closed per branch (`schemas/decision.schema.json:93-95`
  and `:324-325`); and `expectationViolation` (`src/diagnosis.ts:482`) is the reading of the JSON the gate has
  just parsed. `test/unit/diagnosis.test.ts` walks the whole product of class, tool and checks instead of a
  sample of it.
- Every writer satisfies it: `expectationFor` answers `{class, version}` for a class that needs no tool and
  adds `tool` only to the two that do, and the checks of a defect arrive with the bank, in
  `buildDefectDiagnosis`.
- The guard is not machinery for a shape this package never sees. `resolveStagedCandidate` reads the record
  through `readStagedDecision` (`src/gate/flow.ts:1009`), whose fifth guard (`:1037`) judges the expectation of
  every item it found with `expectationViolation` (`:1069`) before the gate plans a run over it, and refuses
  the record with the reason instead of measuring it. A file on disk is not written by the union, and the
  reader is what stands between the two.
- `describeExpectation` (`src/diagnosis.ts:453`) answers one sentence per branch of the union and reads no
  fallback: the branch is the whole input, so a tool class always carries the name the sentence prints and a
  correction never carries one. A record whose payload belongs to another class never reaches it, because the
  guard refuses it first -- which is what made the fallbacks of that function unnecessary instead of merely
  unreachable.
- The guard of an empty diagnosis follows the same split: `buildDiagnosis` still refuses a diagnosis with no
  replay item and the schema no longer does, because how many items are right is a property of the basis and
  each constructor owns its own answer.

### The metrics of the series

`metricsOf` (`src/metrics.ts:109`) is a projection of the ledger and of nothing else: no file, no process, no
clock and no model, and `failureClassesOf` (`:104`) is the same over a list of evidence. It is deliberately
neither of the two things a report of this kind usually is. It is not a cache: a stored rate goes wrong the day
`staging/` is pruned, and correcting it would need a rule of invalidation that nothing asks for, so the numbers
are recomputed on every call. And it is not a judge: it counts the verdicts the gate and the acceptance already
decided, because re-deriving one from the runs would be a second gate that could disagree with the first.

**The two rates, and the one that supports them.**

- `acceptanceRate = accepted / (accepted + rejected + abstained)` (`:66`, `:122`). The denominator is the three
  verdicts of the gate, and `attempts` is their sum computed where they are counted (`:183`), so the total of
  the report and its parts cannot disagree. A `proposed` attempt that never reached a gate stays outside the
  rate: it is not a measurement of the gate, and the vocabulary of the report is filled with the events that
  appear instead of with zeros, because twelve zeros hide that there were no attempts at all (`:131`). The
  three verdicts are read off the event of the line and not off the record (`:193`), because an abstention that
  ended before the budget leaves the record in `not-run` or `preregistered` with the line already written
  (`src/gate/flow.ts`), and demanding a concluded record of the three would drop real abstentions.
- `recurrenceRate = accepted lessons that saw their class come back / accepted lessons in force` (`:123`, over
  the rows of `:78`). "In force" is one rule and it has one owner since M3c: `src/vitality.ts` declares the
  event an acceptance writes (`ACCEPTED_EVENT`, `:29`) and the two predicates the rule is made of -- an accepted
  line whose candidate a later `retired` line of the same skill names with the same `candidateHash` is out of
  the denominator (`isRetired`, `:44`, which walks the moments with `isLater`, `:58`). `src/metrics.ts:325`
  applies it to the acceptance of rule 2 and `isInForce` (`src/standing.ts:210`) to the set of lessons the check
  walks, so the series and the check cannot disagree about which lessons exist. What stays split in two, on
  purpose, is the reading of "accepted": the recurrence demands the event and a record whose `outcome.status` is
  `accepted`, because an acceptance with no readable record has no classes to come back to, while the check
  demands the event alone and counts the acceptance with no record apart in `missingRecords`, because a lesson
  nobody can compare against its record is a hole in the coverage and not a lesson out of force. A shared
  `isInForce` would have to pick one of the two readings and would move a number, so `src/vitality.ts` exports no
  such predicate.
- `gateRegressionRate = regressions / pairs` (`:124`) is the column of support and not the recurrence. A
  regression of the gate is a pair (item, repetition) the incumbent passed and the candidate failed
  (`regressionsOf`, `src/gate/scorer.ts:385`): it is a fact about one candidate and one replay, while a
  recurrence is a fact about the lessons a skill already carries. The two travel under names that cannot be
  confused, and the printed sentence keeps each denominator in its parenthesis (`src/messages.ts:371`).
- A rate whose denominator is 0 is 0 (`:364`), and the sentence that prints it names the attempt that is
  missing instead of printing `0.00` (`src/messages.ts:371`): a zero over nothing is the absence of a
  measurement, never a measurement of zero.

**Why the recurrence is measured by class of failure.** The key is `failureClassesOf(record.evidence)`
(`:104`): the sorted set of `<kind>:<tool>`, derived at read time, with `-` for the classes that watch no tool
(`:46`). It is not the stored `failureSignature`, because a signature is computed over the ids of evidence
(`signatureOf`, `src/diagnosis.ts:531`) and every id carries the timestamp of its failure
(`src/evidence.ts:282-290`), so two sessions that hit the same wall never produce the same one. The class is
coarser on purpose -- it says that a `tool_error` in `read` came back, not that the same failure did -- and
that is the granularity the definition of a regression needs, because a record of another session can be
joined to a lesson by nothing finer.

**The coverage travels with the answer** (`:87`, `:144`). `historyPath` points inside the skill and
`decisionPath` points into a `staging/` anybody may prune, so a rate printed without its coverage claims a
measurement over records nobody read. `records` counts the lines whose record resolved and the ones that named
a record that is no longer there; a line that names no record at all -- a refusal that answered before a
candidate existed -- is neither.

**The split of D-B** (`:34`, `:251`). Among the items of the fourth class that a concluded gate ran, a failed
run without `checkFailures` is a turn a tool sank before there was text to judge, and one with the list is a
text that did not pass the checks of its case (`checksOutcome`, `src/gate/expectation.ts:178`). Two halves, read
off records already written: the split costs no run, and it is what allows the unanimity rule to be discussed
with a number instead of an anecdote.

The report describes and does not decide. `--metrics` reads the index and prints, and nothing in the package
reads a rate to gate, accept or retire anything (`reportMetrics`, `src/command-skill-improve.ts:632`): a number
in front of the gate would be a second rule, and the gate is the only one.

### The check of an accepted lesson

`standingOf` (`src/standing.ts:77`) answers, for every accepted lesson still in force, what its bytes on disk
are worth against the record that accepted it. It is the other half of the tie M2 wrote down: a lesson is
accepted by a record, and until this slice nothing could verify that the file still was what the record said.

**Why the record is the authority and the file is not.** A candidate is serialized with the frontmatter of the
lesson it will become, `status: "accepted"` included, so a candidate the gate rejected stays in `staging/`
carrying that same header, and a `lessons/<slug>.md` whose frontmatter says `accepted` may be the copy of a
rejected attempt. What answers is the pair the record carries -- `candidate.contentHash` over the whole file and
`candidate.bodyHash` over the normalized body -- compared against the bytes on disk now (`:126`).

**The five states, in the order they are decided** (`:41`):

- `missing` -- the file is not there, or a component of its path is a file.
- `unreadable` -- the file cannot be read or cannot be hashed at all: a file nobody can hash is not a file this
  module may call intact.
- `intact` -- the whole file hashes to the `contentHash` of the record (`:149`), whatever its frontmatter says.
- `frontmatter-moved` -- the body still hashes to the `bodyHash` and the file does not hash to the `contentHash`
  (`:154`): only the header around the correction moved.
- `body-moved` -- neither hash matches: the correction itself was rewritten.

**The reference line is a second question and not a sixth state** (`:35`, `:171`). A lesson can be byte-identical
to its record and inert, because pi loads it through the line of `## Lessons` and through nothing else (Q10), so
`referenced` travels beside the state and the `detail` names both problems when there are two.

**And no branch reads `status` or `gate` of the frontmatter** (`:20`). Parsing the lesson to compute its
`bodyHash` is not reading the header as a verdict: it is hashing the file with `lessonHashes`
(`src/writer.ts:99`), the same function the writer stamped the record with, so both sides of the comparison are
one arithmetic. `test/unit/standing.test.ts:335` is the test that fixes it: a lesson whose frontmatter says
`proposed` and whose bytes hash to the record is reported `intact` with `referenced: true`, because the record
decided the acceptance and the header did not.

The path of the lesson comes from the record and never from the inventory (`:106`): the record names it relative
to the skill and `skill.realDir` is the path that survives a symlink, so a skill that moved is still answered by
the record. The row of a skill names its worst state by a severity order (`:70`): `missing` first, then
`body-moved`, then `frontmatter-moved`, then `intact`, with `unreadable` beside the known ones because what
cannot be read is unknown and unknown is its own answer instead of the worst of the known (`:68-69`, `:230-232`). An
acceptance whose record is gone is counted in `missingRecords` (`:59`, `:89`) and left out of the checks: a
lesson nothing could compare against its record is a hole in the coverage, never an intact lesson.

### The retirement of a lesson

`retireLesson` (`src/retirement.ts:145`) is the second and the last path of the package that writes inside a
skill, and the only one that takes something out of it. A lesson that stops applying is not deleted: the file
stays where it is and its frontmatter says `status: "retired"`, which is the tombstone, and the reference line
leaves `## Lessons`, which is what makes the lesson inert -- pi loads a lesson through that line (Q10), so a
retired lesson costs nothing to the next session however intact its bytes are.

**The order of the writes is the contract** (`:11`), and every position of it is a guarantee:

1. the lesson on disk is the one the acceptance measured: its `contentHash` is the one the record of the
   acceptance declares (`:165`). A file that is not there is `lesson-missing`, one whose bytes moved is
   `lesson-drift`, and neither writes anything -- a retirement takes back the lesson that was accepted and not
   whatever the slug names today.
2. the snapshot comes before the first edit (`:183`), as in the acceptance: the skill as it was is always on
   disk when this protocol starts to change it, and a timestamp that is taken is taken.
3. the reference line leaves `## Lessons` (`:189`). This step comes *before* the tombstone and not after it, and
   that is the one reason of the order: if step 4 fails, the file still says `accepted` and the lesson is
   already inert, so running the retirement again finds the pre-image of step 1 intact and finishes. In the
   other order the second run trips over its own pre-image -- the bytes it finds are a tombstone it wrote
   halfway -- and the skill keeps a tombstone nobody can reach with the tool (`:18`).
4. the lesson is rewritten with `status: "retired"` and the same body (`:198`). `retireLessonFile`
   (`src/writer.ts:628`) post-conditions the `bodyHash` before and after, so a retirement that changed the body
   is an error and not a retirement: the state changes and the correction does not.
5. `.history/<timestamp>/retirement.json`, the record of what was retired with which hashes and why (`:222`),
   written after the bytes of the skill landed, into the snapshot this retirement took and only there
   (`writeHistoryRetirement`, `src/writer.ts:729`; the name is `src/names.ts:24`).
6. the `retired` line of the index (`:227`), with the pair of hashes of the acceptance and
   `failureSignature: null` -- the field is required and nullable on purpose (OA4 of M1) -- so the line joins its
   `accepted` by `candidateHash` exactly the way that line joined the `proposed` of the run that produced it.

**`retirement@1` is its own artifact and not `decision@2`** (`schemas/retirement.schema.json:3`,
`src/types.ts:663`). A decision record describes what a gate decided about a candidate: `candidate.kind` is
`const "new-lesson"` and `gate` is a union of six blocks, and a retirement is not a verdict of anything. Opening
`decision@2` for it would have widened the record of a gate to carry a fact the gate never decided; a file with
its own `$id` and its own `format` follows the precedent the case bank set.

**The merit is the user's and there is no gate here** (`:31`). Requiring a measured regression before retiring
would make a lesson that is simply false impossible to take back, which is the case the reason `wrong` exists
for. The vocabulary of the reasons is closed -- `stale`, `superseded`, `ineffective`, `wrong`, `unreferenced`
(`:64`) -- and each key names a state the caller reports differently, with the detail as free text because a
key without a sentence is a reason nobody can act on. The refusals are values and not errors (`:73`, `:81`),
save the ones the protocol does not name -- a snapshot that cannot be taken, a tombstone that cannot be written,
a record that cannot land -- which are thrown the way the rest of the package treats a broken file.

**A retirement is not undone.** There is no `unretire`, no flag that re-adds the reference line and no writer
of `status: "accepted"` over a lesson that is already in the skill; the way back is to propose another lesson
and let it pass its gate. That is the same asymmetry the publication has: the record of what was retired stays
in the snapshot of that retirement, so the decision is auditable after the fact even though it cannot be
reverted.

### The collector of signals

`src/signals.ts` is the only module of the package that runs in every turn of every session. What it does is
decided mechanically from what a turn already carries, so its budget is part of its contract: no model call, no
process, no wall clock and no file read per turn. A turn costs one pass over the `toolCall`s of its message and
one copy of references from `getBranch()` to find the prompt of the user, and the only writes are one line per
new suspicion (`recordSignalLine`, `src/signals.ts:477`).

**The trigger.** `turn_end` (`extensions/index.ts:264`), because the other events do not answer the question:
`session_shutdown` does not always happen -- a kill emits nothing -- and `session_start` does not see the turns
of the session it starts. The handler observes, reports one line per suspicion that is new and answers
`undefined`: it adds no entry, changes no boundary and never throws, because a bug in a notice cannot be
allowed to break the session that reads it.

**The two classes, and how each is detected** (`:15`, `:19`).

- `rewritten-draft`: a call to `write` or `edit` names a file that an earlier turn already wrote, and the
  arguments differ (`:357`). Two calls on the same file in the same turn are the model refining its own draft
  and raise nothing, and the comparison is between the digests of the canonical arguments (`hashOfArguments`,
  `src/evidence.ts:318`) and never between texts, so no content is kept in memory.
- `repeated-request`: the prompt of this turn repeats, in substance, the one of an earlier turn (`:376`). The
  significant tokens of the shorter prompt are a subset of the longer one's and at least three are shared
  (`:59`), where a token is what is left after splitting on everything that is not a letter or a digit,
  lowercased, and kept at five code points or more (`:61`, `:406`). There is no stopword list: it would be a
  vocabulary with no owner.

**The caps, and why each one exists** (`:35`). In memory: eight open suspicions (`:45`), thirty-two tracked
paths (`:48`) and eight remembered prompts (`:51`), the oldest dropped past each cap. In the file: 128 lines
(`:64`), and past it the file is folded at the next hydration -- the last event per id, newest first (`:284`,
`:577`, `:611`). The excerpt is the one cap this module does not own: the number is `MAX_EXCERPT_CODE_POINTS`
in `src/evidence.ts:49`, because the excerpt of a suspicion and the excerpt of the evidence it points at are the
same text, and it travels as a name instead of a literal at the two uses (`:367`, `:397`). The two caps of this
module are not the same rule: the one in memory keeps the cost of a turn flat, and the one on the file keeps a
file a year of sessions grew short enough to be read in one go.

**The suspicion survives the session that raised it** (`:29`). `state/signals.jsonl`
(`schemas/signal.schema.json:3`, `src/names.ts:30`) is append-only, one event per line -- `raised` with the whole
suspicion and `consumed` with the id and the moment -- and the state of an id is its last event. Append-only
avoids the read-modify-write race between two sessions of pi for the same reason the index does
(`appendSignalLine`, `src/writer.ts:225`), and the reader tolerates what it cannot use (`:495`, `:518`): a line
that is not JSON, of another format or without the fields of its event is skipped and counted, and a truncated
tail is discarded instead of being read as the event it almost was.

**The id carries the session** (`:350`), on purpose: the same rewrite in another session is a new occurrence
with its own id, and it is reported again. That is behaviour and not a defect, and it is why a suspicion is a
suspicion and never a defect: the user may have rewritten the draft by choice, and only a confirmation turns it
into a measurable attempt. The confirmation arrives as `--signal=<id>` and opens the directional attempt, which
needs a bank to measure it (`src/command-skill-improve.ts:544`): a confirmation with no bank spends nothing, and
the suspicion stays open and retryable.

**The child of a replay registers nothing.** The factory returns at its first statement when
`PI_SIMPLE_SRI_REPLAY=1` (`extensions/index.ts:189`), so a replay hydrates no collector, raises no suspicion
and writes no line of `state/signals.jsonl` -- the same guard that stops a replay from starting another propose
over itself.

**The rule of the identical prompt.** pi emits `turn_end` once per assistant turn, and the agent loop runs
several turns under one user message, so a prompt identical to the one of the previous turn is the same message
and is not remembered twice (`:198`, `:387`). The consequence is written into the detection: a repeat that a new
user message spells identically is read as the message it repeats and raises nothing, because the tokens cannot
tell "asked again on purpose" from "the loop went on", and guessing would raise a suspicion at every turn of a
loop the agent runs under one message.

### The observer

`src/observe/` detects corrections after the fact, across sessions, and proposes a lesson for the pattern they
form. It is opt-in (`pi-simple-sri.observe.enabled`, default false, read by `readObserveConfigOf` in
`src/config.ts`, apart from the skills lists so a broken `observe` cannot take eligibility down). It spends no model
call per turn: the contract of the collector of signals below still holds, and the judge is deferred.

**Modules**, one responsibility each:

| Module | What it does |
|---|---|
| `types.ts` | Constants, the closed union of events, the id function (`observeId`: prefix plus 12 hex of sha256 of the JSON of the parts) and the shapes the others hand to each other. `schemas/observe-event.schema.json` mirrors the union, and a test keeps them from drifting |
| `session-file.ts`, `episodes.ts` | Read-only access to the session files (`sessionsRootOf`, grouped or flat layout, never `run-*`), reading to the last newline through pi's parser (old formats migrate there), and segmentation into episodes |
| `prefilter.ts`, `redact.ts` | The deterministic flags (tool error, correction lexicon EN/ES over user-authored text, rewritten draft, repeated request) and the secret redaction |
| `judge.ts` | The prompt, the reading of the answer (through `src/json-reply.ts`), `providerGate` and the cost estimate. The model arrives as a `CompleteFn` |
| `store.ts`, `cursor.ts`, `lock.ts`, `forget.ts` | The tolerant reader and the fold of `observe.jsonl`, the cursor, the scan lock and `--forget` |
| `beta.ts`, `patterns.ts` | The posterior, decay, grouping findings into patterns and the threshold |
| `banks.ts`, `auto-bank.ts` | Which bank measures a skill (`resolveBank` answers `found`, `absent` or `unusable`) and the generator of a bank from episodes |
| `review.ts`, `outcome.ts`, `prompts.ts` | `reviewProposal`, the classification of a gate result, the dialogs and `dispatchReview` |
| `setup.ts` | `--setup`: the side-effect scanner and the write of `replay.allow` |
| `cycle.ts`, `labeling.ts` | The sequencing of one cycle, and the labeled records of a dry-run |
| `wire.ts` | Binds the real collaborators to `CycleDeps` and `ReviewDeps`, and decides when a cycle may start |

**The store.** `state/observe.jsonl` is append-only, one event per line, written by `appendObserveLine`
(`src/writer.ts`) with mode 0600, in the order of the calls. The union is closed: `opt-in`, `episode`, `judged`,
`observation`, `proposal`, `prepare-failed`, `prompt`, `gate-outcome`, `tombstone` and `forget`. There is no stored
pattern: a pattern is the set of observations that share a `patternId`, and the id of a new one is derived from its first
observation. A proposal id is `observeId("pr", [patternId, candidateHash, stagingPath])`, so every staged candidate has its
own proposal, and a proposal records the `skillContentHash` (`sha256:<hex>` of the `SKILL.md` at staging). An
episode holds pointers into a session file (`sessionFile`, entry ids) and no content; an observation holds a redacted
summary of at most 300 characters. Clean episodes are stored too, because they count against the pattern.
`readObserveLog` tolerates what it cannot use as the signals reader does: a line that is not JSON, of another format or
type, or without the fields the fold reads is skipped, and a truncated tail is dropped.

`foldObserveState(events, now)` is pure and applies, in order: dedupe by id (a fork shares the entry ids of the
prefix it copied, so a rescan sees the same episode twice; the spike confirmed ids survive a fork for the shared
prefix only; the first one wins, except for an episode, where the latest `episode` event per id wins because its end
moves when the session grows), drop everything that started before `optInAt` (a note or a self-report is never cut by
it: the user or the skill wrote it on purpose), drop everything of a skill at or before its `forget` (compared with the
time of the session, so an old session scanned again after the forget does not bring the skill back), and drop
anything older than 365 days. The time of an observation is its episode's `startedAt`, and its own `at` when it has no
episode. Proposals, tombstones and prepare failures are compared by their own `at`. A `judged` event is a duplicate of
another with the same episode, model and outcome, which is why the daily budget counts a persistently failing episode
once, however often it is retried. Decay is not applied there: it is the reader's job, at read time, with a 90-day
half-life.

**The lock, and why it is an exception to the append rule.** The log is appended with `O_APPEND` and no lock, as
the index is. `withScanLock` (`lock.ts`) guards only the two operations that read a whole file and write it back: the
scan and `forgetSkill`. It is `state/observe.lock`, claimed with `createExclusiveFile` and kept alive by a
heartbeat every 60 seconds; a lock not written for 5 minutes is stale and the next caller takes it over, but only the
very lock it judged stale. Each holder carries a token, checks it before it beats and before it releases, and `fn`
receives a signal that aborts when the lock was lost. The gate and the dialogs never run under the lock; the lock
is the one thing the package takes besides the file mutation queue, and it guards the rewrites, never an append, so the
rule of the index (O_APPEND, one write per line, no lock) is intact for the three append-only files.

**`--forget`** (`forget.ts`, `forgetSkill`, under the lock) erases:

- from `observe.jsonl`: the `episode`, `observation`, `proposal`, `prepare-failed` and `tombstone` events of the skill, the
  `judged` of those episodes and the `prompt` and `gate-outcome` of those proposals; a line that is not JSON is dropped
  too, because it may hold what is being forgotten;
- from `signals.jsonl`: every line of an id that has a `consumed` line naming the skill;
- the content of every staged candidate of the skill that was never accepted (`eraseStagingContent`: lessons and bank
  copy) and its `gate/runs/`; of the accepted ones only the bank copy (`eraseStagingBank`) and `gate/runs/`; the drafts in
  `staging/observer-banks/<skill>-<12 hex>` (matched whole, so `demo` never takes `demo-skill`), and `banks/<skill>.json`
  only when its provenance is `auto`;
- `trigger.focus` and `diagnosis.summary` are set to null in the `decision.json` of every candidate of the skill, accepted
  or not, and in the record of each acceptance in `<skill>/.history`, because they name the pattern.

It keeps `attempts.jsonl`, `.history`, the lessons of accepted candidates, the verdicts of every `decision.json`, banks the
user wrote or the skill ships (it reports them), a bank it cannot read (not known to be generated) and every `forget`
event. The `forget {skill, at}` event is appended FIRST, right after taking the lock, so a failure in the rewrites or the
artifacts never leaves a half-forgotten skill without its cutoff. A history record that cannot be cleared (ledger path
outside the `.history` of the skill, missing directory, moved skill, unreadable record) is not thrown: its path goes to
`ForgetReport.historySkipped` and the command warns; a path that escapes the perimeter is never followed. `recordsCleared`
counts the `decision.json` files nulled (staging and history). The artifact half is `discardSkillArtifacts(base, skill)`, which `forgetSkill`
calls and which the cycle binds as `CycleDeps.discardArtifacts`: it touches no event and takes no lock, so a cycle that
already holds the scan lock can call it. `rewriteFile` reads the file, reads it again right before the write and plans
again if it changed, so a line appended in between is not dropped; the instant between that second read and the
rename is not covered (see the limits), and appends take no lock. A file rewritten by a forget ends with mode 0600. Every
directory the observer owns is made by `ensurePrivateDir(dir, base)` (`src/writer.ts`), which checks the perimeter before
the mkdir. It replaced `ensureStateDir` (which created the state directory outside the chokepoint) and the three
`mkdirSync` of `wire.ts`: `cursor.ts`, `lock.ts` and `wire.ts` call it, and `appendObserveLine`, `writePrivateFile` and
`createExclusiveFile` create their directory through it, so no `mkdirSync` of the observer bypasses the chokepoint.

**The cursor** (`state/observe-cursor.json`, keyed by the id of the session header) only decides whether a file is read
again, by path, size and mtime. It holds no offset: a file is always parsed to its last newline and the fold dedupes
what was seen. A file touched less than 30 minutes ago, and the session in progress, are skipped until a later start. A
cursor that is lost or damaged costs a re-read and nothing else. `cursorEntryOf` stores the hash of the first line; `planScan`
does not compare it.

**One cycle** (`runObserveCycle`, `cycle.ts`) does no I/O of its own; every collaborator arrives in `CycleDeps`.
Modes are `background`, `scan` and `dry-run`.

1. Under the lock: write `opt-in` if there is none, plan the scan, read each file, segment, and for each episode
   whose stored end (`endEntryId`) differs from the one just read (a resumed session grew, so it is processed again;
   the latest `episode` event per id wins in the fold): skip it if the skill was forgotten at or after the episode's
   `startedAt` (before the prefilter and before any judge call), prefilter, judge within the daily budget and the
   provider gate, assign patterns, append the events of the file and then advance its cursor. A judge that failed or
   was skipped does not consume the episode: nothing marks it done, its file does not advance the cursor, and a later
   start judges it again (a failed call is recorded in `judged` and counts against the budget; a skipped one never
   happened and does not). A file with an episode left unjudged (budget, provider mismatch, abort, failed or skipped
   judge) does not advance its cursor.
2. Outside the lock: take the proposable patterns in order (posterior, then weight, then id) until one yields a
   proposal; a pattern that could not be prepared, or whose lesson is already in the skill, does not hold back the next.
3. Prepare. A skill not in `replay.allow` is on probation. Otherwise `resolveBank` is asked: `found` gates against it,
   `absent` falls through to generation, and `unusable` (a bank that exists and cannot be read, in `banks/` or shipped
   by the skill) makes `wire.ts` throw the "exists and cannot be used as a bank" error instead of generating a bank over
   it. The cycle catches that throw for the pattern: it is a failed preparation (`prepare-failed` with the error as
   reason), the next pattern is tried, and nothing is generated over the file. Without a bank, `selectBankEpisodes` needs 2 cases from 2 sessions in one cwd (the cwd of the session wins), then
   the generator writes a draft in staging before the lesson exists, and the proposer never sees its checks. With too few
   cases the pattern is `pending`, and after 14 days it falls to probation. `proposeSkill` then runs with `observed:
   {patternId, gate}` on the surface `observer`; its focus carries the rejected candidates of the pattern (tombstones
   `user-rejected` and `gate-rejected` only; `accepted` and `stale` are not refusals). A `pending`, a failed generation
   or proposal, an unusable bank, a candidate whose hash already has a tombstone, and a bank promotion that throws each write a
   `prepare-failed` event (reason redacted, at most 200 characters): the pattern waits 24 h after its first failure, 72 h
   after the second and 7 d after the third or later, counted from the latest.
4. Which proposal is live. Only the **latest** proposal of a pattern (by `at`) is live, for the cycle's reuse and for
   `--review` without an id alike (`latestProposals`); a restaged candidate replaces it and earlier ones are never gated
   or offered again. The latest is reused instead of regenerated unless its hash has a tombstone or its gate was
   rejected. If the ledger already holds an `accepted` line for its hash (`isAccepted`), the cycle writes a tombstone
   with reason `accepted` and goes to the next pattern. A retryable gate outcome on the reused proposal is not retried on
   the same candidate (a concluded record is not gated again): a **fresh** candidate is staged, at most twice per pattern
   (`MAX_GATE_RESTAGINGS`, counted over all the retryable outcomes of the pattern's proposals); the next retryable answer
   makes the following candidate a probation one.
5. Dialog (a): Later, Approve, Reject (60 s timeout counts as `later`). `replay.allow` is read again first: a `bank`
   proposal for a skill the user took out of the list writes a `retryable` outcome (`refused`, `replay-not-allowed`)
   without asking and without promoting a bank, and the next start stages a fresh candidate, which is on probation. On
   Approve an auto bank is promoted to `banks/` (`createExclusiveFile`; a path already equal to the promoted bank of the
   skill is returned unchanged, and an identical existing file is accepted) and the gate runs in the background;
   probation skips the gate and records `PROBATION_OUTCOME`, `{class: "not-measurable", status: "probation", reason:
   "not measured"}`.
6. Dialog (b) and the dispatch. The Accept of (b) only dispatches `--review=<id>`, which asks again; the cycle never
   accepts and never reloads. During `--scan` the surface replaces the dispatch with a no-op and the command runs the
   review inline (see M2 below).

After every `await` of the offer phase (after `bank.select`/`generate`, after `propose`, before `promote`, before
`runGate`, before each dialog) the cycle re-reads the fold, and if the skill was forgotten at or after the moment the cycle
started it stops without writing that proposal and calls `CycleDeps.discardArtifacts(skill)` (`discardSkillArtifacts`:
artifacts only, no event rewrite, no lock). A `discardArtifacts` that throws is caught, the skill is listed in
`CycleReport.discardFailed`, and the cycle goes on.

**The lifecycle of a pattern**, as `patterns.ts` and the tombstones decide it. A pattern is closed by a tombstone and
reopens when an observation of the pattern is dated after the latest tombstone, where "dated" is the **session time**
(the observation's episode `startedAt`; its own `at` when it has no episode), never the moment the log learned of it: a
session that ended before the tombstone and is read after it does not reopen the pattern. The tombstone reasons:
`user-rejected`, `gate-rejected`, `accepted` (the lesson is in the skill) and `stale`. `stale` is written by
`reviewProposal` when `accept` is refused as `skill-drift` and when a proposal has no `skillContentHash` (a legacy one):
it closes that proposal, prompt (b) is not offered again for it, and the pattern reopens like any other on a newer
observation. Other gates: snooze (24 h after `later`/`timeout`), one proposal per 24 h in total, the backoff of the failed
preparations above. A gate result is classified by `classifyGateResult` with an exhaustive `assertNever` over the
reasons: `below-threshold` and `judge-failed` are rejected (tombstone), `no-improvement` is not measurable, and every
reason that proves nothing is retryable. A not-measurable bank outcome is offered in prompt (b) as "not measured" and,
if accepted, the concluded record is converted to a probation one.

The prompts show `realRuns`, the number of gate runs planned (`planDesign(cases, "case-bank").design.plannedRuns`:
arms x repetitions x items, at most), not how many times the pattern was seen; a probation proposal plans none and says
"not measured". Prompt (a) always carries `GATE_PROOF_NOTICE` (D3) and prompt (b) carries it when the lesson was
measured: the gate shows the lesson makes the cases pass, not that the pattern is real.

**Probation** is a gate status of its own (`GATE_STATUSES`, `DecisionOutcomeStatus`), not a flag. `probationRecordOf`
(`src/gate/probation.ts`) turns a not-run replay record, or a concluded case-bank record whose gate abstained for
`no-improvement`, into a probation one (any other record is refused: it would erase a verdict), `acceptCandidate` accepts
it after the same skill-drift check against the hash recorded at staging (`recordedSkillHashOf` reads it from the
preregistration or the `probation` block), metrics count probation on its own and leave it out of every
rate, and `--verify` treats a probation lesson as intact. The lesson frontmatter `gate` is `accepted` or `probation`.
The decision surface `observer` is its own so that a record never claims a surface that did not make it.

**M2 is intact.** Only the command reloads. The background cycle dispatches `/skill-improve --review=<id>` (the id
travels as `--review=<id>`; `--review <id>` with a space names no id and is refused) with
`pi.sendUserMessage(text, {expandPromptTemplates: true})` (`dispatchReview`, mode `deferred-command`). The spike
(pi 1.5.2, real TUI) found that an idle dispatch runs the extension command and `ctx.reload()` works inside it, but
that a dispatch while streaming also runs the command, and its `ctx.reload()` returns silently without reloading
(pi shows a warning). So the dispatch happens only if the session is idle, otherwise it is deferred to `agent_settled`
(`ObserveRuntime.settled()`), re-checking `isIdle()` right before the send; if it is not idle then, the user gets a notice
with the command. A failed send is a notice too. Callbacks still waiting are dropped on `session_shutdown`. A reload is
never assumed: `runReview` reloads only after an acceptance, through the shared `waitForIdle` -> reload helper.

During `--scan` there is no nested message: `surface.scan` replaces `dispatchReview` with a no-op, the cycle reports
`review-dispatched` with the proposal id, and `runScan` calls `runReview(id)` inline with the command context (the only
one that can reload), which asks again and reloads once, only on an acceptance. Other spike facts the code relies on: `ctx.ui.select` accepts `{timeout,
signal}` and returns `undefined` for a timeout, Esc and an abort alike, so the code reads `signal.aborted` to tell the
abort apart and counts the rest as `later`; `session_start.reason` is `startup | new | resume | fork | reload` and only
`startup` and `new` start a cycle; `ctx.mode === "tui"` is the TUI test (`hasUI` is also true in RPC); the sessions
directory comes from `ctx.sessionManager.getSessionDir()`. The 1.4.0 devDependency was not tested by the spike.

**The review** (`reviewProposal`) takes only the latest proposal of a pattern; one that is tombstoned or already accepted
answers `nothing-to-review`. A proposal with no `skillContentHash` is closed with a `stale` tombstone. It asks prompt (a)
first when the user never approved the lesson (and the bank), so a `--review` of a proposal the cycle never offered still
asks before it spends. It never gates a probation proposal. For a bank proposal whose outcome is missing or retryable it
calls `promoteBank` (which refuses a skill no longer in `replay.allow` before writing anything: the review notifies and
answers `retryable`) and gates in the foreground against the promoted path; a rejected outcome tombstones, a retryable
one notifies that a fresh candidate is staged at a later start. Then `offerAcceptance`, the answer is recorded, and
`acceptCandidate` runs only on Accept with `expectedSkillContentHash` = the `skillContentHash` recorded at staging, never
one computed at accept time. A `skill-drift` refusal (or no hash) closes the proposal with a `stale` tombstone. For a
probation proposal, and for a bank outcome that is `not-measurable`, the accept wraps `probationRecordOf`, which also
accepts a concluded case-bank record whose gate abstained for `no-improvement` (its basis stays in the record). On an
acceptance the review writes a tombstone `accepted`. `--review` without an id walks the latest proposals newest first
and takes the first that is not `nothing-to-review`.

**The wiring** (WP14a): `extensions/index.ts` starts the cycle on `session_start` only when the reason is `startup`
or `new`, the mode is TUI, the session is top-level and not a replay child, and observe is enabled. It is
fire-and-forget behind an `AbortController`, and `session_shutdown` aborts it, which is why the header of the
extension no longer says there is no such handler: the cycle is a session-scoped resource. The background task
checks the signal after every await and an interrupted gate is `retryable`. `agent_settled` calls
`ObserveRuntime.settled()`, which runs the callbacks `dispatchReview` deferred.

**Bugs fixed on the way**, named in the code and tests:

- B1: the `<skill>` block was read as what the user typed. `splitSkillBlock` (`src/skill-block.ts`) is used by the
  evidence (so the replay prompt no longer carries the block twice and the diagnosis keys are computed on the
  user's text) and by the signals' `userPromptOf`.
- B2: `turnIndex` is reset by pi on every agent run, so "same turn" was wrong. The collector now uses the ordinal of
  the user prompt on the branch, and the signal id hashes `[kind, sessionId, anchorEntryId, subject]`.
- B3: `compactSignalFile` wrote newest first while the reader folded from the tail as if it were newest. It now writes
  the last event of every id, oldest first, keeping the newest 128. It also carries over what another session appended
  between its read and its write: it re-reads the file and keeps every complete line that is not in the `seen` set of the
  first read, comparing by **content** and not by position, because a session that compacted first leaves a file shorter
  than the one that was read (the shrink case a positional tail would get wrong). `SignalCollectorOptions.afterRead` is
  the seam a test uses to be that other session. The instant between the second read and the rename is the one window
  left, and a line lost there is a suspicion the session that raised it still reported.
- B4 (exclude bank from overlay): `copySkillTree` skips `case-bank.json` (`EXCLUDED_COPY_ENTRIES`), so a bank shipped
  inside a skill never reaches the replay arms. The gate's own bank copy sits in staging next to the candidate and is
  unaffected. Not to be confused with the older label B4 in `src/config.ts`.
- The false promise of `messages.ts` and of the tool description that the tool "records a correction": the `record`
  action now does what that says, and only that: it appends a self-report (weight 0.4), never edits a skill and
  never accepts. It answers `observe-disabled` when `observe.enabled` is off, which is why the notice is conditional:
  "When `pi-simple-sri.observe.enabled` is on, ...". `record` takes the skill and the note in `focus` (at most 300
  characters; empty or longer answers `error`).
- One shared reader of a model reply that must hold one JSON object, `src/json-reply.ts` (`firstObjectWhere`: every `{`
  is a candidate start, the balanced object that opens there is parsed, braces inside strings do not count, and the
  first one the caller accepts wins), used by `proposer.ts`, `judge.ts`, `auto-bank.ts` and `setup.ts` instead of four
  copies.
- `resolveBank` is tri-state (`found`, `absent`, `unusable`): a bank that exists and cannot be read used to be `null`,
  the same as no bank, and a generated bank would have replaced it. `forget.ts` uses the same reader to tell an `auto`
  bank from one that is not known to be generated.

**Known limits**, left as they are:

- `--setup` rewrites `settings.json` as 2-space JSON, so other formatting is lost. It re-reads the file right before
  writing and prints a snippet if it changed.
- Implicit attribution reads the session in file order, not along the active branch, and is noisy: an assistant that
  read a `SKILL.md` for another reason is attributed a run of the skill.
- `--forget` removes by the `skill` of an event and by the ids that hang from it. Content that carries no `skill` field
  stays: a signal that was raised and never consumed names no skill, so it is not erased. It keeps `forget` events,
  `attempts.jsonl`, `.history`, accepted candidates, user and skill-shipped banks, and the verdicts of `decision.json`.
- The unlocked window of `--forget`: `rewriteFile` re-reads right before the write, but a line appended between that
  second read and the rename is lost, and appends (`--note`, `record`, a signal) take no lock.
- `--forget` leaves titles and slugs in the `decision.json` of forgotten candidates, does not touch the files of the
  labeling dry run, and does not change staging directories of older versions (0755/0644). A record of a moved or missing
  skill keeps its text (`historySkipped`). Two long distinct titles can map to the same slug, the class of the old 64-char
  cut.
- F-3: after a `stale` close, an identical lesson proposed again the same day has the hash of the closed candidate, so
  the cycle writes a prepare failure ("the candidate was already decided on") and the pattern waits 24 h.
- The judge budget deduplicates `judged` events by episode, model and outcome, so an episode that fails every time is
  counted once however often it is retried, and the daily cap understates what was spent on it.
- The dry-run sample is the most recent N episodes by `startedAt` (default 30, `--limit=<n>`), not a random one.
- A note or a self-report joins the latest pattern of the same skill and source, so notes about different corrections of
  one skill add up in one pattern.
- The dispatch was spiked on pi 1.5.2 only. On the 1.4.0 devDependency the behaviour of `sendUserMessage` with
  `expandPromptTemplates`, of the deferral and of the dropped reload is untested.
- The gate proves the lesson makes the cases pass, not that the pattern is real; a probation lesson was never measured.
- `scripts/` is outside `tsconfig` and outside the published files.

## Tests

The suites under `test/unit/` never start a process, touch the network or read a real skill. The gate
is driven end to end with a fake `runReplay`, a fake clock and a skill fixture in `mkdtemp`; the replay
runner is driven with a fake child, and `buildReplayArgs` is asserted as data, so the argv is checked
without `pi` existing. The bank base is driven the same way, with a fake judge, and `createModelCall` is only
ever handed a stub registry whose single method is a fake: no test builds a provider, a credential or a real
`ModelRegistry`.
