# Developer notes

Working notes for this package. Not part of the published documentation.

## Layout

| Path | Contents |
|---|---|
| `extensions/index.ts` | Entry point loaded by pi. Stays thin: registers the command and the tool, no logic |
| `src/` | One module per responsibility: config, eligibility, inventory, evidence, diagnosis, frontmatter, proposer, perimeter, writer, messages, command, tool |
| `src/attempts.ts` | The event vocabulary of the index, the reserved names, the attempt hashes and the one constructor of a line |
| `src/gate/` | The paired replay gate: execution contracts, expectation evaluator, arm overlays, replay runner, scorer, flow, acceptance |
| `schemas/` | Versioned JSON schema for `decision.json`, validated by tests |
| `test/unit/` | Unit tests, `node --experimental-strip-types --test` |
| `test/fixtures/` | Settings files and skill trees, including symlinks |
| `tmp/` | Local design notes: goal, decisions, plan, review. Gitignored |

`src/gate/`, one responsibility per file:

```
src/gate/
├── types.ts           execution contracts: one replay run, one verdict, the closed reason lists
├── expectation.ts     the reading of one run against the expectation of its item
├── overlay.ts         the two arms of the gate, built inside staging from the skill
├── replay-runner.ts   one `pi` child per run: argv, JSONL parsing, the caps
├── scorer.ts          planGate, evaluateGate, the Wilson interval
├── flow.ts            resolve the candidate, preregister, spend the budget, judge, record
└── acceptance.ts      the order of the writes that edit an accepted skill
```

The split is the one that keeps the decision auditable: `types.ts` declares shapes and nothing else,
`expectation.ts` and `scorer.ts` are pure over data -- no process, no file, no clock -- so a stored
stream can be re-read and its verdict re-derived, `replay-runner.ts` is the only module that starts a
process, and `flow.ts` is the only module that decides to spend. Nothing outside `src/gate/` imports a
module of `src/gate/` except the two surfaces, and the replay runner is not resolved by the extension
factory: opening a runner arms nothing, but the rule is that the gate decides to run and never the
wiring.

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
  in-process queue still wraps the append, so two callers of the writer cannot interleave.
- The gate measures copies. Both arms are built inside the candidate directory of staging and the
  replay is pointed at them, so a gate that passes and an acceptance that fails leave the skill exactly
  as it was.

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
7. The reload of the session. **Not implemented: M2.**

The staged `decision.json` is never rewritten to `accepted`: it keeps the `gate-accepted` the gate
decided, and the index line is what tells the two states apart.

### Where M2 enters

M2 inserts two calls at the end of the command handler, after `acceptCandidate` has returned its
answer: `await ctx.waitForIdle()` and then `await ctx.reload()`. Order matters -- a reload while the
session is still producing a message is a reload of the wrong state -- and queueing `/reload` is not an
alternative, because it is a TUI command and not an extension command.

The contract has to widen for it. `SkillImproveContext` (`src/command-skill-improve.ts`) declares
neither call today; M2 adds `waitForIdle(): Promise<void>` and `reload(): Promise<void>` to it. pi's own
command context already provides both, so the widening is a compile-time assertion that the wiring
passes a context which can do the two things, and not a runtime probe. The marker for the insertion
point is the `// M2:` comment at the end of `acceptCandidate`.

## Extending the artifacts

Three artifacts outlive the version that wrote them: the index, the `gate` block of a decision record
and the schema as a whole. Each has one written rule.

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
- `RESERVED_ATTEMPT_EVENTS` holds the names this version recognizes and does not emit. `no-baseline` is
  the only member: it is reserved for the gate that finds no baseline to compare against, which is not
  a state M1 can reach. Recognizing a name and emitting it are two different permissions.
- M1 does not emit `gate-accepted`: a gate that passes writes no line, and the line of an accepted
  candidate is the `accepted` event the acceptance writes when it edits the skill. The intermediate
  state lives in `decision.json`, where it cannot be confused with the record of a write.

### The gate block

- `gate.basis` names how the gate decided: `const "replay"` today, and an enum once a second basis
  exists. With a single basis the members of the block are told apart by `status`; a second basis is one
  more member keyed by its own `basis`, and from then on `basis` is the discriminator.
- Every detail that depends on the basis lives under a key named after it -- `gate.replay` today,
  `gate.caseBank` for a basis that is not a replay. The top-level fields (`basis`, `status`, `budget`,
  `tokens`, `preregistration`) are neutral to the basis: `budget` is runs, `tokens` is spend, and
  `preregistration` is "what was written down before the first run", a mechanical threshold today and a
  preregistered rubric for another basis.
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

A candidate staged under an older schema is refused, not migrated: `resolveStagedCandidate` reads one
schema and reports `unsupported-schema` for anything else, because a record half of each version would
be written by a gate that could not tell what the fields mean.

## Tests

The suites under `test/unit/` never start a process, touch the network or read a real skill. The gate
is driven end to end with a fake `runReplay`, a fake clock and a skill fixture in `mkdtemp`; the replay
runner is driven with a fake child, and `buildReplayArgs` is asserted as data, so the argv is checked
without `pi` existing.
