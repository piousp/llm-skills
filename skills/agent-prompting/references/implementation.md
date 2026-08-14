# Implementation delegation (T3): worker vs TDD, seams, frozen tests

This reference expands template T3 in the skill's SKILL.md. Use it when an
approved plan exists and one seam is defined. [NEVER] delegate implementation
before the plan exists: the plan names the seam, the files in scope, and the
frozen tests. Without it the executor cannot know where to stop.

## When to pick each variant

| Variant | Agent | Lens | Pick when | Output |
|---|---|---|---|---|
| Worker | worker | pablo-code-philosophy, or any lens that sizes the seam | A sized seam with a defined contract; the executor can verify its own result | Lens output, else Execution Summary (Task, What I did, Files, Status) |
| TDD | worker | pablo-tdd | The change is behavior-first; you want the red-green loop enforced | Lens output, else Execution Summary |
| code-implementer | code-implementer | Method-supplied lens file, always required | The coordinator runs builds and tests itself and wants a blind writer that only puts code on disk | Handoff summary (Changed files, Verification for the coordinator, Flags) |

Decision rules:

- Worker variant: the worker has read, write, edit, and bash, so it can run
  the tests itself and report a Status. Use it when the seam contract is
  precise and the executor can tell done from not-done without asking.
- TDD variant: same agent, different method. Use it when you want the loop
  as the discipline: one failing test first, then minimal code, then the
  full test selector.
- code-implementer: use it when the harness reserves builds and test runs to
  the coordinator. The agent has no shell and no subagents; it writes code
  and tells the coordinator exactly what to run. It works blind (no red or
  green bar), so it reasons statically and never claims a test result.

## Scoping the seam

A seam is the public boundary where behavior is observed and tested. The
plan proposes seams; the user confirms them; the delegation prompt names
exactly one.

- One seam per invocation. [NEVER] bundle two seams in one prompt.
- Files in scope: the exact paths the seam may touch. Everything else is
  out.
- The prompt states the seam contract so the executor can tell done from
  not-done without asking.
- No gold-plating: correct and green, not elegant. No refactors beyond the
  seam, no adjacent cleanups, no speculative abstractions.
- Stop on failure: if a command fails or a file is missing, report the error
  and stop. No improvised unverified workarounds.
- Clean tree: temporary files created during the run are removed before the
  summary.

## Frozen tests

Frozen tests are the tests the plan designated as the regression baseline
for the seam. The delegation prompt names them with a selector and states
the invariant: [NEVER] edit, delete, or weaken these tests.

- "Weaken" includes narrowing assertions, removing cases, skipping, and
  changing the expected value to match the code.
- The reason is independent verification: frozen tests are the check that
  the seam works, run after the change by the worker (worker and TDD
  variants) or by the coordinator (code-implementer).
- If a frozen test fails for a reason the seam cannot fix, that is a report,
  not a license to touch the test.
- New tests for the seam are welcome and are written against the seam, never
  against internals (see pablo-tdd: tests live at seams, and [ALWAYS] test
  only at pre-agreed seams).

## Anti one-shot: orientation steps

A one-shot prompt that describes the change and nothing else invites the
executor to improvise from assumptions. The fix is orientation steps at the
top of the objective: steps that force the executor to look before writing.

Always include, in order:

1. Read the plan slice.
2. Read the files in scope and their neighbors: existing tests, fixtures,
   helpers, naming conventions.
3. Read the frozen tests and confirm the seam contract against them.
4. Then implement.

The worker's own system prompt already says "explore before acting"; the
delegation prompt makes it explicit and binds it to the seam. Without these
steps the executor may write code that looks right and misses the actual
contract.

## code-implementer variant (annotated)

code-implementer runs exactly one explicitly named mode per invocation,
defined by a lens/instructions file the coordinator must supply. With no
lens it makes no changes. Key properties to respect when writing the prompt:

- No lens, no changes. The prompt must name the lens path (or paste the
  content and label it as the lens) and the mode: "Mode: <name>". An
  ambiguous or absent mode means the agent stops and says what is missing.
- No execution. The agent has read, grep, find, ls, write, and edit only.
  It cannot run builds, tests, or scripts, and it must never claim a test
  passed or failed.
- Blind writing. Because it cannot see a red or green bar, the prompt asks
  it to reason statically: read enough surrounding code to know, before
  writing, exactly why the test will fail and why the implementation will
  make it pass. The summary states both so the coordinator can confirm them
  against the real run.
- Handoff summary. Every invocation ends with: Changed files, Verification
  for the coordinator (what to run and what result confirms the work), and
  Flags and open questions.
- The coordinator independently runs the verification. Never paste a test
  result the agent could not have observed.

## Example: worker variant with orientation steps

```
Lens: read and apply
/home/pablo/.pi/agent/skills/pablo-code-philosophy/SKILL.md before touching
anything. If you cannot read it, make no changes and say so.
skills: []

Plan slice (verbatim):
<the approved plan slice naming this seam>

Seam: Invoice.total()
Files in scope: src/main/java/com/example/billing/Invoice.java,
src/test/java/com/example/billing/InvoiceTest.java

Frozen tests: InvoiceTest#total* . [NEVER] edit, delete, or weaken these
tests.

Objective: implement only this seam.
Orientation: first read Invoice.java and InvoiceTest.java in full. Read the
frozen tests and confirm what total() must return for the cases they cover.
Then implement the minimal change that satisfies the seam contract and keeps
the frozen tests green.

Output contract: follow the lens output format; otherwise emit the Execution
Summary with these fields: Task, What I did, Files/resources created or
modified, Status (COMPLETED | COMPLETED (with notes) | BLOCKED).

Limits:
- One seam per invocation.
- No gold-plating, no refactors beyond the seam.
- Stop on failure and report the error; do not improvise unverified
  workarounds.
- Leave the tree clean; remove temporary files you created.
```

## Example: TDD variant skeleton

```
Mode: TDD.
Lens: read and apply /home/pablo/.pi/agent/skills/pablo-tdd/SKILL.md before
touching anything. If you cannot read it, make no changes and say so.
skills: []

Seam: <seam name>
Frozen tests: <selector>. [NEVER] edit, delete, or weaken these tests.

Plan slice (verbatim):
<the approved plan slice>

First write ONE failing test for the seam. Then write the minimal code to
make it pass: correct and green, not gold-plated. Run the full test
selector. Do not apply anything beyond this seam.
```

## Checklist before sending

- Plan approved and quoted verbatim.
- Exactly one seam; files in scope listed.
- Frozen tests named with a selector and the [NEVER] invariant.
- Orientation steps present (worker variant).
- Output contract present: lens format or Execution Summary.
- Limits present: one seam, no gold-plating, stop on failure, clean tree.
- For code-implementer: lens path and explicit mode present; the coordinator
  is ready to run the verification.

## Template (T3)

Use when: an approved plan exists and one seam is defined. [NEVER] delegate
before the plan exists. Pick the worker variant for a sized seam with a
lens; pick the TDD variant to run the red-green loop.

Worker variant:

```text
Lens: read and apply <path to the lens SKILL.md> before touching
anything. If you cannot read it, make no changes and say so.
skills: []

Plan slice (verbatim):
<paste the approved plan slice>

Seam: <seam name>
Files in scope: <paths>

Frozen tests: <test selector>. [NEVER] edit, delete, or weaken these
tests.

Objective: implement only this seam. Correct and green, not gold-plated.
Do not apply anything beyond this seam.

Output contract: follow the lens output format; otherwise emit the
Execution Summary with these fields: Task, What I did, Files/resources
created or modified, Status (COMPLETED | COMPLETED (with notes) |
BLOCKED).

Limits:
- One seam per invocation.
- No gold-plating, no refactors beyond the seam.
```

TDD variant:

```text
Mode: TDD.
Lens: read and apply <path to pablo-tdd SKILL.md> before touching
anything. If you cannot read it, make no changes and say so.
skills: []

Seam: <seam name>
Frozen tests: <selector>. [NEVER] edit, delete, or weaken these tests.

Plan slice (verbatim):
<paste the approved plan slice>

First write ONE failing test for the seam. Then write the minimal code
to make it pass: correct and green, not gold-plated. Run the full test
selector. Do not apply anything beyond this seam.
```
