# Finding taxonomy

Every printed item gets one primary category, one per item. `scripts/store.py` parses the
numbered lines below (`^\d+\. slug:`), so this list is the single source of truth: keep the
format and the order.

1. correctness-scenario: a concrete input that produces wrong output in the changed logic (qa-adversary)
2. contract-compat: public API, schema, event, or wire-format change that breaks a consumer (qa-adversary)
3. concurrency: races, ordering, or shared mutable state with an evidenced concurrent caller (qa-adversary)
4. error-handling: swallowed, mistyped, or missing failure paths; retries, timeouts (qa-adversary, code-review-checklist)
5. ops-runtime: config, resource, logging, or deploy-time behavior that surfaces in operation (qa-adversary)
6. build-metadata: versions, dependency coordinates, build and CI files (code-review-checklist)
7. domain-assumption: a business rule the diff assumes and no read-only lookup can confirm (qa-adversary)
8. test-oracle: a test whose assertions cannot fail for the bug it claims to cover (qa-adversary, code-review-checklist, pablo-test-review)
9. coverage-gap: a new branch or behavior with no test (qa-adversary, code-review-checklist, pablo-test-review)
10. duplication-reuse: repeated logic, or an existing helper that was not reused (code-review-checklist, refactor-identification)
11. type-modelling: stringly-typed closed sets, missing equals/hashCode, weak data types (code-review-checklist, refactor-identification)
12. encapsulation: leaked internals, setters on read-only data, wide visibility (refactor-identification)
13. abstraction-structure: a missing or misplaced abstraction, mixed responsibilities (refactor-identification)
14. complexity-size: long functions, deep nesting, relative growth of an already long unit (code-review-checklist)
15. naming-docs-style: names, comments, formatting, local conventions (code-review-checklist)

## Rules

- One primary category per item: the category of the fix (the root cause), not of the symptom.
- A scope question takes the category of the element it asks about ("scope" is not a category).
- The coordinator tags while merging; the lenses are untouched.
- Findings are tagged with any of the 4 lenses, `pablo-test-review` included (tag it by its own
  name, never as `code-review-checklist`).

## Decision rules

Taggers confused five categories. Tag by the fix and by what the item asks or asserts, not
by its topic. Questions follow the same rules: tag the thing the answer would settle.

Tie-break order (first match wins; apply it only when two or more rules fit):

1. `correctness-scenario`, 2. `error-handling`, 3. `contract-compat`, 4. `ops-runtime`,
5. `domain-assumption` (the residual: use it only when no earlier rule fits).

- `correctness-scenario`: you can write the failing input from the diff alone (an input, a
  state, or a null/empty/boundary value, plus the wrong result), and the fix is a logic
  change. A data assumption inside the scenario does not move it. Example: "an empty list
  makes the new average divide by zero".
- `error-handling`: the subject is what happens when something fails: catching, rethrowing,
  classifying, retrying, timing out, or reporting a failure, including the question "is a
  retry safe". The fix is in the failure path. Example: "the new catch returns an empty
  list and hides a failed lookup".
- `contract-compat`: the diff changes or newly enforces a shape that code on the other side
  of a boundary reads or writes (field, type, signature, status code, message or event
  format, accepted values), and the item states who breaks or what they now see. Naming the
  consumers is optional. Example: "a renamed JSON field that clients read".
- `ops-runtime`: it works only if something outside the code is true when it runs: a config
  key or env var is set, a resource or pool exists, deploy order, a limit, window, size, or
  timeout value, log or metric behavior. Tunable numbers and missing infrastructure go here
  even if only the owner knows the answer. Example: "reads a new env var that staging does
  not define".
- `domain-assumption`: the item asks for, or rests on, a fact about the business, the data,
  or another team's system that nobody can confirm from the diff or the repo (which values
  production sends, whether a state occurs, what the rule is meant to be). Example: "assumes
  the upstream never sends an empty region code". An item that asks "which values does the
  producer send?" is this category; an item that states "the new check rejects values the
  producer sends today" is `contract-compat`.

## Tags

- `code_kind`: `prod` | `test` | `build` | `script` | `dev-tool`. By path: `src/test`,
  `*Test`/`*Spec`, an integration-test module → test; pom/sbt/CI files, and `.tf` files → build;
  `*.py`/`*.sh` → script; QA or developer tooling → dev-tool; everything else prod.
- `premise`: `in-diff` | `1-hop` | `external-unverified` (where the evidence for the item lives).
- `kind`: `finding` | `question` | `gap` | `nit`.
