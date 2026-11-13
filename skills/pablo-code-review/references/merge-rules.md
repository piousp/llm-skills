# Merge rules (pablo-code-review)

Read before step 4 (merge). Every lens item lands in exactly one tier or is dropped.

## Tier map

Strict bump: a lens item that names a `pablo-code-philosophy` principle (a checklist Minor
carrying a tag) moves up to Major before any merge. Untagged items keep their tier. An item
whose root cause or excess predates the diff is exempt and stays Minor.

| Lens item | Report tier |
|---|---|
| qa-adversary BLOCK/HIGH passing the Blocker gate | Blocking (B) |
| qa-adversary BLOCK/HIGH/MEDIUM whose scenario needs a premise outside the diff | Question (Q) |
| qa-adversary MEDIUM, premise in the diff | Major (M) |
| qa-adversary LOW | Minor (I) |
| qa-adversary Open Question | Question (Q) |
| qa-adversary NOT COVERED / PARTIAL | Coverage gap (G) |
| checklist Blocker passing the Blocker gate | Blocking (B); failing it: Question (Q) |
| checklist Major | Major (M) |
| checklist Minor with a principle tag (`- [Minor] [KISS] ...`) | Major (M) |
| checklist Minor without a tag | Minor (I) |
| checklist Question | Question (Q) |
| checklist Nit | Nit (T) |
| checklist FYI | dropped |
| pablo-test-review Major / Question / Minor / Nit / Coverage gap | M / Q / I / T / G; never Blocking |
| refactor-identification P1 | Major (M) |
| refactor-identification P2 | Minor (I) |
| refactor-identification P3 | Observation (O) |
| refactor-identification Unresolved | Question (Q) if the answer could make it P1 or P2; else dropped |
| any lens Filtered out | never printed |

Dedupe vs qa-adversary: same `file:line` and same root cause, one item tagged with both
lenses; its tier is qa-adversary's only if qa supplied a production failure scenario, else
the test lens's.

Merge order:

1. Map each lens item through the tier map, then apply the strict bump.
2. A lens part whose premise is outside the diff becomes its own Question; it does not merge
   into in-diff parts, so an in-diff Major never disappears.
3. Merge the in-diff parts by root cause and take the highest tier, except the qa+test Dedupe
   rule above, which stays as written.
4. Blocking requires the Blocker gate; an item failing it is a Question.

Verdict: BLOCK iff at least one B; NEEDS WORK iff at least one M; else PASS. Q, I, T, G and O
never change it.

Blocker gate and Root cause mirror `pablo-pr-review` `references/merge-rules.md`; update both together.

## Blocker gate

Blocking needs every premise of the failure scenario visible in the diff or 1 hop away in the
same repo. A premise marked "pending grep" or "could not run", or resting on another repo,
deploy order, environment config or an unread consumer, fails the gate: the item becomes a
Question whose text is the question to post plus the lookup that settles it. A config file or
snapshot in the local checkout is not evidence of deployed state.

## Root cause

One item = one root cause = the one fix that removes it. Items from any lens that one fix
removes merge into one item tagged with every lens. Structural violations in the same method
(length, nesting, complexity) are one item; when the excess predates the diff it is Minor. An
item that needs two independent fixes is two items.

## Test strength and scope

- Test strength: owned by `pablo-test-review`; take its tier as given. An R1 item (removed or
  loosened oracle) stays Major. Naming the missing assertion or test is part of its finding.
- Outside the diff: an item anchored outside the diff, or needing state outside it, is a
  Question with its lookup, or dropped past the cap. Never a finding.

## Caps

- Questions: at most 3. Each one gates a B/M and is anchored on a changed line. It reads as the
  comment to post plus "What to check". Past the cap, keep those gating the highest tier.
- Coverage gaps: qa-adversary NOT COVERED/PARTIAL lines and pablo-test-review gaps are one
  list, at most 3, using the test lens's ranking: new branch with no test > changed behavior
  tested only for the old behavior > edge case. Each: file:line, input → expected, suggested
  test name. Deduplicate across lenses; skip QA/dev-only tooling.
- Observations: at most 3, refactor P3 only.
- Nits: only with the exact replacement.
