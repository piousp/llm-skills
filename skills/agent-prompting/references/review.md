# Review delegation (T4): lens selection, severities, lanes

This reference expands template T4 in the skill's SKILL.md. Use it for
pre-merge review, QA, refactor detection, or any read-only audit. The agent
is analyst (read-only, no write tools). One lens per invocation; [NEVER] mix
lenses in one prompt.

## When each lens

| Lens | Lane | Answers | Use when | Not for |
|---|---|---|---|---|
| code-review-checklist | Quality and merge gate | Does this change pass the coding-philosophy checklist? What test coverage is missing? | "Review my changes", "am I ready to merge", the checklist gate before a PR | Correctness deep-dives, refactor economics |
| qa-adversary | Correctness, regressions, business rules | Will this break anything? Is the behavior right for every input and downstream consumer? | "QA this", "will this break anything", "find bugs in my change", "is this covered" | Style, naming, abstractions, scope discipline (another lane) |
| refactor-identification | Structural refactor candidates | Is there a structural refactor worth investing in, inside this branch's diff? | "Refactor candidates", deciding if a refactor belongs in this branch, a deep-dive after a broader pass | Merge verdicts, executing refactors, whole-repo scans, renames |

Complementarity:

- code-review-checklist and qa-adversary are the two independent critics:
  the checklist owns quality and the merge gate; qa-adversary owns
  correctness. They do not overlap by design; each lens tells the analyst to
  stay out of the other's lane.
- refactor-identification is a zoom-in, not a gate. It deepens four
  structural categories (missing abstractions, weak encapsulation, poor
  data types, flags where a sealed ADT fits) with quantified evidence and a
  when-not-to-report gate (N1-N8). It identifies direction only; the how
  lives in gof-design-patterns and functional-programming.
- The lens description decides the trigger, not the file name. Read the
  description when unsure.

## Severity schemes

Each lens defines its own verdict vocabulary. The delegation prompt demands
the lens template verbatim, and the coordinator reads the verdict in that
lens's terms. Never cross-map severities between lenses.

code-review-checklist:

- Tiers: Blocker, Major, Nit, Question, FYI. Blocker covers Red Flags only,
  and any single Blocker fails the review.
- Verdict: READY | NEEDS WORK (B blockers, N major, M nits, Q questions, K
  coverage gaps).
- Reports violations only, no praise. A section with zero violations prints
  "pass".

qa-adversary:

- Finding severities: BLOCK, HIGH, MEDIUM, LOW. A finding needs a concrete,
  reproducible failure scenario (inputs, then the wrong output or crash);
  without one it is a doubt, filed under Open Questions.
- Verdict: PASS | BLOCK | NEEDS CLARIFICATION. BLOCK requires at least one
  BLOCK/HIGH finding with a scenario, or a business-rule violation.
- Open Questions is a first-class section, always present.

refactor-identification:

- Findings are [RF-n] blocks with a category (A1-A4), a priority (P1/P2/P3),
  evidence with file:line, a gate note (N1-N8 checked), and a one-line
  refactor direction.
- Filtered out lists candidates rejected by the gate. No merge verdict.

## Combined reviews

The two independent critics can both run on the same change, but never in
one prompt. Run two analyst invocations, one per lens, then merge the
digests at the coordinator.

- Order: code-review-checklist first, then qa-adversary, is the common
  sequence: quality gate before the correctness attack. The reverse works
  too; keep them as separate invocations either way.
- refactor-identification usually runs after a broader pass surfaced
  candidates, as its own invocation.
- The merged digest keeps each finding in its lane with its own severity:
  a qa-adversary BLOCK is not a checklist Blocker, and vice versa. The
  coordinator decides which verdict gates the merge.

## Lane separation

- One lens per invocation. [NEVER] ask the analyst to "also check style"
  while running qa-adversary, or to "also look for bugs" while running
  code-review-checklist.
- A lens may forbid tools the analyst otherwise has (qa-adversary never runs
  or delegates test runs; bash stays read-only). The prompt reinforces the
  lens's limits: read-only, no test runs, no edits.
- Context block: what changed, intent source (ticket, goal, or baseline),
  frozen tests, and prior gates (for example, "this code has NOT been
  through code-review-checklist; you are its first reviewer").
- Fail closed: if the analyst cannot read the lens, it stops and reports; no
  default review runs.

## Example: qa-adversary invocation

```
Lens: read and apply /home/pablo/.pi/agent/skills/qa-adversary/SKILL.md
before reviewing. If you cannot read it, stop and report; run no default
review.
skills: []

Context:
- What changed: src/main/java/com/example/billing/Invoice.java (branch
  feature/invoice-total, commit range origin/main...HEAD)
- Intent source: goal.md section "Invoice totals", ticket BILL-14
- Frozen tests: InvoiceTest#total*
- Prior gates: this code has NOT been through code-review-checklist; you are
  its first reviewer

Objective: review ONLY the categories qa-adversary defines: logic changes,
data handling, business rules, regression risk, concurrency and state,
oracle-hard correctness, and failure and degradation paths. Give the verdict
per the lens scheme.

Output contract: emit the lens template verbatim; findings as file:line with
severity and a concrete failure scenario. No style comments. If nothing
critical, say so in one line and stop.

Limits:
- Read-only. No test runs, no edits.
- Review only this change, not surrounding code.
- Do not cross lanes: one lens per invocation.
```

For code-review-checklist, use the same prompt with the lens path and
objective changed to the checklist's categories and verdict. For
refactor-identification, the objective names the four structural categories
and the output is the [RF-n] template.

## Checklist before sending

- Exactly one lens, by path, fail-closed.
- skills: [] present.
- Context block filled: what changed, intent source, frozen tests, prior
  gates.
- Output contract demands the lens template verbatim.
- Limits present: read-only, only the change, no lane crossing.

## Template (T4)

Use when: pre-merge review, QA, refactor detection, or any read-only audit.
One lens per invocation; [NEVER] mix lenses in one prompt.

```text
Lens: read and apply <path to the lens SKILL.md> before reviewing. If
you cannot read it, stop and report; run no default review.
skills: []

Context:
- What changed: <paths or diff reference>
- Intent source: <ticket, goal, or baseline>
- Frozen tests: <selector, if any>
- Prior gates: <e.g. this code has NOT been through code-review-checklist;
  you are its first reviewer>

Objective: review ONLY the categories the lens defines. Give the verdict
per the lens scheme.

Output contract: emit the lens template verbatim; findings as file:line
with severity. No style comments, no naming nits, no minor improvements.
If nothing critical, say so in one line and stop.

Limits:
- Read-only. No test runs, no edits.
- Review only this change, not surrounding code.
- Do not cross lanes: one lens per invocation.
```
