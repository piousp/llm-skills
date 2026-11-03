# Developer notes

Working notes for this package. Not part of the published documentation.

## Layout

| Path | Contents |
|---|---|
| `extensions/index.ts` | Entry point loaded by pi. Stays thin: registers the command and the tool, no logic |
| `src/` | One module per responsibility: config, eligibility, inventory, evidence, diagnosis, frontmatter, proposer, perimeter, writer, command, tool |
| `schemas/` | Versioned JSON schema for `decision.json`, validated by tests |
| `test/unit/` | Unit tests, `node --experimental-strip-types --test` |
| `test/fixtures/` | Settings files and skill trees, including symlinks |
| `tmp/` | Local design notes: goal, decisions, plan, review. Gitignored |

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

## Rules that came out of the design

- Acceptance is command-only. The tool can diagnose and propose, never write a skill.
- Every write goes through one chokepoint wrapped in `withFileMutationQueue()`, with atomic writes and
  read-back verification.
- The write perimeter is the realpath of an eligible skill directory plus `staging/` and `state/`
  under the write base. Nothing else.
- The write base is `<agent dir>/sri` (`src/write-base.ts`), derived from `getAgentDir()` and never
  from the package root: with `pi install npm:pi-simple-sri` the package lives inside `node_modules`
  and an upgrade would take staging and state with it. Records name paths relative to the base.
- Skills are edited through symlinks when they point at another repository; the extension never runs
  git.
- Acceptance reloads the runtime with `await ctx.waitForIdle()` and `await ctx.reload()` at the end of
  the command handler. Queueing `/reload` does not work: it is a TUI command, not an extension command.
- `state/` and `staging/` are per user, shared by every installation of the package. A base that
  cannot be written is a clean failure, not a fallback, and a base inside a skill directory is refused.
