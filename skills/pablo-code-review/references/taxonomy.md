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

Tie-breakers for categories taggers confused. Ask what the item is mainly about.

- `domain-assumption`: the premise is a business or data fact only the owner or producer
  knows (which values or formats production sends, which services exist or consume X).
  Example: "assumes upstream never sends an empty region code".
- `contract-compat`: mainly a changed public, wire, or API shape or its consumers, even if
  the consumers are unknown. Example: "renames a JSON field that clients read".
- `ops-runtime`: mainly deploy order, environment config, infrastructure that must exist,
  timeouts or retries. Example: "reads a new env var that is not set in staging".
- `error-handling`: mainly how a failure is handled, propagated, or classified.
  Example: "catches the exception and returns an empty list, hiding the outage".
- `correctness-scenario`: a concrete input gives a wrong output in the changed code, even
  when a data assumption is involved. Example: "input 0 divides by zero in the new ratio".

## Tags

- `code_kind`: `prod` | `test` | `build` | `script` | `dev-tool`. By path: `src/test`,
  `*Test`/`*Spec`, an integration-test module → test; pom/sbt/CI files → build;
  `*.py`/`*.sh` → script; QA or developer tooling → dev-tool; everything else prod.
- `premise`: `in-diff` | `1-hop` | `external-unverified` (where the evidence for the item lives).
- `kind`: `finding` | `question` | `gap` | `nit`.
