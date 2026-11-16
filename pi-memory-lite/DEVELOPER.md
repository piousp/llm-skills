# pi-memory-lite — development notes

Working notes for this package. They ship inside the published package, but they are not user
documentation: that is `README.md`.

## Layout

| Path | Contents |
|---|---|
| `extensions/index.ts` | The entrypoint pi loads: it subscribes to `session_start`, `session_shutdown` and `before_agent_start`; inside the first it reads the settings, checks the Node version, registers the four tools with their renderers and warns about name collisions; inside the second it closes the connection; inside the third it puts the one `<memory_lite>` section the turn needs into `systemPromptOptions.sections` or deletes the key, and warns once when the tools turn out to be unreachable. No SQL, no budget arithmetic, no formatting. |
| `src/config.ts` | `resolveConfig()` and `checkNodeVersion()`: from the raw settings, the environment and `agentDir` to the effective configuration. Pure functions; neither throws on what a user typed into a JSON file. |
| `src/tools.ts` | The four declarations the host sees (description, `promptSnippet`, schema, `exposure`, annotations) and the four executors: they validate the arguments, normalize the keys and the category, and delegate to the store. |
| `src/db.ts` | Opening, pragmas, the core schema and the FTS schema kept apart, migrations, the FTS5 probe on `:memory:`, the index `rebuild`, and the whole query layer. `openStore` retries the WAL pragma on `SQLITE_BUSY`, and `createStore` picks the FTS5 or the degraded search-and-count pair once, at open (`QueryLayer`), for the life of the store. The only module that imports `node:sqlite`, and it does it dynamically. |
| `src/query.ts` | The pure surface of the index: `toTokens()`, `quoteToken()` and `toMatchTerm()` for FTS5 (a token of three or more characters becomes a quoted prefix term), `foldForSearch()` for the accent folding of the degraded search, `toSlug()` for the controlled vocabulary, `distinctSlugs()` for the keys of an entry, `normalizeTextForDuplicate()` for duplicate detection and `toTerms()` for the denormalized column. |
| `src/format.ts` | The text that goes back to the model: caps for the catalog (1500), search (800) and read (2000), the per-fragment budget, the word-boundary clip with an ellipsis, and the explicit declaration of what was left out. Pure functions over rows. |
| `src/secrets.ts` | `secretKindOf()`: the patterns (AWS key, GitHub token, private key, Slack token, `password=value`) `memory_write` rejects, returning the kind and never the match. |
| `src/render.ts` | The TUI face of the four tools: one line per call and per result while the row is collapsed, and the text the model read when it is expanded. The lines come from `TOOL_LINES`, a private table with one entry per tool name, so a name added to `MEMORY_TOOL_NAMES` without its two lines fails to compile instead of rendering an empty row. |
| `src/prompt.ts` | `MEMORY_PROMPT_SECTION` and `memoryPromptSectionFor()`: the tag and the text of the conditional `<memory_lite>` section, computed from `selectedTools` minus `hiddenTools`, then checked against `registeredTools` — the names `pi.getAllTools()` reports — because those two lists cannot tell a declaration hidden for this turn apart from a tool the session does not have: a `-t` allowlist that leaves one of the four out removes it from the registry, where neither `tool_search` nor a codemode script can reach it. When the registry holds the four, the resolved `exposure` decides which of the two mechanisms the section may name — `tool_search` indexes only the non-`direct` tools, so it is a remedy only for the modes that took the declarations away. Pure over those inputs — no host, no I/O, no clock — and the three texts are the contract, which is why the suite pins them whole instead of matching fragments. |
| `test/unit/` | One suite per module of `src/` — the section of `src/prompt.ts` in `prompt.test.ts` — except `src/render.ts`, whose lines are covered by `extensions-index.test.ts` (lifecycle, exposure, budget, prompt section and rendering), plus `concurrency.test.ts` (two real processes). 232 tests through `npm test` (at 0.3.0). |

## Setup

Node 24.19.0 on this machine; `engines` declares `>=22.14`, which is the floor `node:sqlite` needs (23.5 on the 23 line). Dependencies
are installed and the three control commands are:

```bash
npm install
npm run typecheck
npm test
```

There is no build step: pi loads the extension through jiti, so the `.ts` imports resolve directly, which is why
the tsconfig uses `allowImportingTsExtensions`. The tests run on Node's native type stripping, the default since
22.18; on 22.14 to 22.17 the `test` script needs `--experimental-strip-types` added. That is a limit of the test
harness and not of the package: pi does not take that path.

Two rules that took time to learn, and that are not worth undoing:

1. **The settings and the tool registration live inside `session_start`.** `pi.getSettings()` and
   `pi.getAllTools()` throw while the extension is loading (`Extension runtime not initialized. Action methods
   cannot be called during extension loading.`). Subscribing to events is allowed during the load, so the
   factory only subscribes: it reads the settings, checks the version, registers the four tools and compares
   names inside the handler. Moving any of those four things into the module body breaks the start of every
   session.
2. **The WAL pragma is retried on `SQLITE_BUSY`.** Two simultaneous openings of a fresh database make
   `PRAGMA journal_mode = WAL` fail with `SQLITE_BUSY` (errcode 5) through SQLite's lock-upgrade deadlock
   detection, a path on which the busy handler is never consulted: `busy_timeout` does not cover it and raising
   it changes nothing. `switchToWal()` in `src/db.ts` retries ten times, 25 ms apart, and only for that error;
   anything else is rethrown untouched. Without that retry the opening fails intermittently and the concurrency
   criterion stops holding.

## Settings contract

The key is `pi-memory-lite` and it carries four fields:

| Field | Contents |
|---|---|
| `dir` | Directory that holds the memory database. Must be a non-empty absolute path. |
| `categories` | The controlled vocabulary of categories the tool accepts. Normalized to slugs, empties and repeats dropped, and a vocabulary that ends up empty degrades to the default list. |
| `allowUnknownCategory` | Whether a category outside the vocabulary is accepted or refused. Only `true` accepts it. |
| `exposure` | How the tools are exposed: `direct`, `codemode` or `deferred`. The field chooses the mode, not the content: the two non-default values keep the four declarations out of `<tools>`, and what the prompt then says about them comes from `src/prompt.ts` — one section naming the mechanism that reaches them, or the fact that none does. Memory content never enters the prompt. |

The defaults are `categories = ["general", "decision", "preference", "env", "project", "gotcha", "convention",
"workflow", "reference", "person"]`, `allowUnknownCategory = false` and `exposure = "direct"`.

Directory precedence is `PI_MEMORY_LITE_DIR` > `settings.dir` > `<agentDir>/lite-memories`: the environment variable
exists so a test session can be isolated without touching the settings file. `agentDir` comes from the host's
`getAgentDir()`, which honours `PI_CODING_AGENT_DIR`.

Configuration enters through `pi.getSettings()`, which returns the effective copy: the global
`<agentDir>/settings.json` merged with the project's only when the project is trusted, plus the session
overrides. `settings.json` is never read by hand anywhere: that would reimplement the merge and ignore project
trust. The host's `Settings` type has no index signature, so the block is read with a cast to
`Record<string, unknown>` and parsed in `resolveConfig()`, which never throws: every invalid level falls through
to the next one and leaves a warning, and that warning goes both to the log and to the session UI. The extension
never refuses to load over a badly written setting.

Every setting is read and applied inside `session_start`; a change applies on the next session or after
`/reload`, which runs the factory again and fires `session_start` again.

## Degradation matrix

| Condition | Behaviour |
|---|---|
| The database has no FTS5 | Search degrades to one `LIKE` per token over `text` and over `terms`, with `%` and `_` escaped, on accent-folded text (a deterministic SQL function `fold`, registered only in this mode); the fragment is 240 characters; the order becomes `id` descending instead of BM25. Catalog, count, `read`, `write` and `delete` work the same, and so does finding an entry by a key its text does not contain. |
| It was written without FTS5 and reopens with FTS5 | `meta.fts_disabled` is set: on open, `rebuild` runs over `entries_fts`, `integrity-check` verifies it and the mark is deleted. Without that, the entries of that window would be invisible to search and would raise no error. |
| It opens without FTS5 on a database written with FTS5 | The three external-content triggers are dropped before the mark is written: if they stayed, every `INSERT` and every `DELETE` on `entries` would fail with "no such module: fts5". The stale index stays in the file as a shell that connection never reads, and the next open with FTS5 rebuilds it. |
| Node older than 22.14, or 23.0 to 23.4 | The four tools are registered anyway, but every call returns a readable error naming the version found and the floor it missed instead of failing on the module import. The database is never opened. |
| `node:sqlite` is missing from the binary | Same as the case above: the import is dynamic and happens inside the first open, not during the load. |
| The database was written by a newer version of the package | The open fails with an error naming the stored and the supported version and asking for an update. Nothing is degraded and nothing is truncated. This is also what a 0.2.x build does with a schema v2 database. |
| A schema v1 database opens with this build | Migration 2 rebuilds `entries` and `keys` with `AUTOINCREMENT` by copying the tables, and sets `meta.fts_disabled` so the next open with FTS5 rebuilds the index. |
| Invalid settings | The default of that field is used and a warning is reported in the session. |
| The four tools are not declared in the turn and no mechanism reaches them | The four tools are installed but nothing in the turn declares them, so the model would never learn they exist. The entrypoint writes the `<memory_lite>` section saying they are unreachable and naming the ways out, and warns once per instance with the same string. The case has more than one cause: an exposure that is not `direct` with neither `tool_search` nor `codemode` declared, a `codemode.mode: "only"` that hides the declarations of the callable `direct` tools, and a `-t` allowlist that leaves one of the four out of the session registry. That last cause is why `src/prompt.ts` also reads the registry: an allowlisted-out tool is not hidden but absent from `pi.getAllTools()`, so no search returns it and no script calls it, and the section has to say `unreachable` instead of naming `tool_search` — which it does even with `tool_search` declared and the exposure set to `deferred`, the configuration a live session spent four turns searching in. Nothing self-heals: enabling `tool_search`, enabling `codemode`, setting `exposure` to `direct` and fixing the allowlist are all a person's moves. |

## Context budget

There is no fixed ceiling on the always-loaded text. The test `criterio 2` in `test/unit/extensions-index.test.ts`
measures and reports it (`t.diagnostic`) and asserts only that no schema property carries a description. The count is
`description + promptSnippet + JSON.stringify(parameters)` over the four tools, as they arrive at `pi.registerTool`
inside the `session_start` handler, plus the XML-escaped name and description of the skill as the `<skills>` block
carries them. Measured at 0.3.0 with `exposure: "direct"`: tools 1410 characters + skill 120 = 1530.

The measurement is taken on the arguments `registerTool` received and never on a copy built for the measurement. Two
rules keep the number honest: no schema carries a per-property description, and `promptGuidelines` is not declared at
all, since it would add bullets to `<rules>` and break the criterion that the prompt differs only in the `<tools>`
entries and in the tool declarations. A change that grows the number is judged in review against what it buys, not
against a constant.

The `<memory_lite>` section is not part of that number: it is not paid while the four are declared, and in the two
non-default modes it is what the prompt pays instead. Its three texts, measured with the four names missing — the longest
the sentence gets — are:

| Section | Text | Wrapped in its tag |
|---|---|---|
| `tool_search` | 199 | 228 |
| `codemode` | 228 | 257 |
| `unreachable` | 286 | 315 |

The wrapper is `+29` characters, which is `<memory_lite>`, a newline, the text, a newline and the closing tag; the host
skips a section whose body is empty, which is why the entrypoint deletes the key instead of emptying it. Growth per turn
is zero: the section is written once and patched only when the set of declared tools changes. `test/unit/prompt.test.ts`
asserts each text whole and the absence of newlines.

The alternative was to declare the guidance as `promptGuidelines` on the four tools, which also survives the declarations
being hidden. It was not used, for two reasons: those bullets are part of the declaration, so they would be there in
`direct` as well, where the prompt already names the tools; and a bullet lives inside `<rules>`, so adding or removing it
makes that whole section the diff unit, while a section of its own is a patch of one key.

### Measuring the prompt

No test can see the rendered system prompt: the host builds it after the handlers run and does not export the builder.
The suite pins what can be pinned — the section map is not mutated in `direct`, the texts and their ceilings — and the
rest is measured in a real session with a probe that costs nothing:

```ts
// A throwaway extension, loaded after the package's own: it captures the prompt and exits before the model is called.
import { writeFileSync } from "node:fs";
export default function probe(pi: any) {
  pi.on("before_agent_start", (event: any, ctx: any) => {
    writeFileSync(process.env.PROBE_OUT!, JSON.stringify({
      prompt: event.systemPrompt,
      sections: event.systemPromptOptions.sections,
      selectedTools: event.systemPromptOptions.selectedTools,
      registry: pi.getAllTools().map((tool: any) => `${tool.name}:${tool.exposure}`),
    }));
    process.exit(0);
  });
}
```

`PROBE_OUT=out.json pi --no-session -e extensions/index.ts -e probe.ts -t read,bash \
  memory_write,memory_search,memory_read,memory_delete -p ok` writes the prompt and stops; the `-p` text never reaches a
model. Three rules make the number mean something: pass `-e` for the probe **after** the package's extension, because
handlers run in load order and the section is written by the package's handler; use the same `-t` on both sides of a
diff, or the allowlist difference is measured instead of the extension; and never measure in `session_start`, where the
tools are not registered yet and the diff is empty for the wrong reason.

What that measurement has to keep showing: `direct` differs from a session without the extension in exactly the four
`<tools>` lines; a mode that keeps them out adds exactly one `<memory_lite>` block; and no stored memory text
appears in the prompt in either case. A configuration change is checked the same way, with the block edited in the
project's `.pi/settings.json` under `--approve`.

## Test rules

- One file per module, named after the module: `src/query.ts` is tested in `test/unit/query.test.ts`. The
  exceptions are `src/render.ts`, whose lines are tested in `extensions-index.test.ts` beside the entrypoint's
  lifecycle, and `concurrency.test.ts` (criterion 8).
- Temporary directories are created with
  `fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-memory-lite-<area>-"))` and cleaned up in
  `t.after`, never in the body of the test: a test that fails in the middle has to leave the directory just as
  clean.
- Rows returned by `node:sqlite` have a null prototype, so they are not compared with `assert.deepEqual` against
  an object literal. Fields are compared one by one, or the row is spread before it is compared.
- The concurrency suite spawns two real processes, and it must never be made green by staggering them. The two
  children of `spawn(process.execPath, ["--input-type=module", "-e", ...])` open the same database and write a
  hundred entries each at the same time; that is what criterion 8 asserts and what exercises the WAL retry. A
  `sleep` between the two spawns, or serializing them in any other way, leaves the test green without testing
  anything: when it fails, fix the code and not the calendar.

## Search and write behaviour

- Ranked search quotes each token and adds `*` from three characters on. When nothing matches all the words it retries
  with any word and returns a note saying so. Rows carry the whole text when it fits, else a word-boundary clip with an
  ellipsis; the FTS snippet is 32 tokens.
- `memory_search` has no `count_only`; the catalog already carries the counts. Catalog lines do not start with `#`.
- `memory_write` rejects a secret before any database access (`src/secrets.ts`). An exact duplicate merges its new keys
  into the existing entry and the reply names the keys added and those cut by the limit of `MAX_KEYS` (8). The
  `Similar: #a, #b` hint (up to 3 ids, ranked by shared keys) is computed after the commit, so it cannot fail a write.
- The `category` schema of `memory_write` is an enum of the configured categories unless `allowUnknownCategory` is true;
  the executor still normalizes to a slug, because direct calls skip the schema.
- `openStore` creates the data directory with mode 0700; an existing directory is untouched.
- The `unreachable` prompt text is a constant, since it no longer names the missing tools.

## Known limitations

- Duplicate detection is an O(n) scan over the table on every write, which is fine at notebook scale.
- The degraded search path does not rank: it returns by `id` descending.
- There is no `memory_update`. Correcting an entry is `memory_delete` followed by `memory_write`, and the new entry gets
  a new id; ids are never reused (`AUTOINCREMENT`), so an id quoted earlier is either the same entry or absent.
- The memory is global only: there is no per-project scoping and no `source` field, so an environment note about
  one machine is visible from every project on that machine.
- The schema is at version 2. A new change adds `{ version: 3, up }` to `MIGRATIONS`; a migration that touches an
  existing table uses `ALTER TABLE` or copies it as version 2 does, and one that touches the FTS table sets
  `fts_disabled` or runs `rebuild`.
- The test harness needs Node 22.18 or newer to run without flags; on 22.14 to 22.17 the `test` script requires
  `--experimental-strip-types`. The package does not: pi loads it with jiti.

## Release

The package is published from `.github/workflows/publish-memory-lite.yml`, which lives at the root of the
monorepo and runs with `working-directory: pi-memory-lite`. It is triggered by hand only
(`workflow_dispatch`), over OIDC with `npm stage publish`. There is no `NPM_TOKEN`: the npm CLI exchanges the
runner's OIDC identity for a short-lived publish token. The trust relationship is configured on npmjs.com and
names the exact filename of that workflow, so renaming it breaks publishing until the connection is deleted and
created again. The publish stays in stage and goes to production when a person approves it on npmjs.com.

The job order is the usual one: `npm ci`, `npm run typecheck`, `npm test` and `npm stage publish`. The version
published is the one in `package.json` at that commit, so a release is a version bump committed to `main`, a
push and then the dispatch; a version already on the registry fails the last step and leaves nothing staged.
