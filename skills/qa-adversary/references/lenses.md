# The conglomerate — QA bug-hunting lenses

*Distilled from practitioner best practices (BrowserStack, QA Madness, Virtuoso, Ranger on
AI-generated code) and academic foundations (regression test selection, mutation testing, the oracle
problem / metamorphic testing). Citations at the bottom of SKILL.md.*

### Lens 1 — Logic-change bugs
- Inverted / weakened / strengthened conditionals (`&&`↔`||`, `>`↔`>=`, negation dropped).
- Off-by-one and boundary drift in loops, ranges, indices, pagination, retries.
- Changed default values, changed enum/constant, changed switch/match arm, missing `else`/default.
- Reordered operations where order is significant (validate-then-persist, lock-then-read).
- Early return / short-circuit that now skips a required step.
- Silently swallowed or broadened exceptions; a domain error path that no longer fires.
- **Constraint-inversion probe**: assume the opposite of each of the author's implicit assumptions
  (reversed input order, flipped polarity, event-driven instead of polled) and check whether the
  logic still holds under that inversion.

### Lens 2 — Data-handling bugs
- **Null / empty / absent**: null vs empty collection vs missing optional field; `Optional.get`
  without presence check; empty list treated as success.
- **Boundary values** (BVA): min, max, zero, just-inside/just-outside every constrained input;
  off-by-one at limits; rounding, truncation, overflow/underflow, precision (money, ratios).
- **Type / format mismatches**: numeric parsing, date/time & timezone, encoding/charset, unit
  mismatches, serialization (e.g. Jackson/circe/spray-json) field renames or type widening/narrowing.
- **Mutation of shared/input data**: a method that now mutates its argument or shared state.
- **Collection semantics**: dedup, ordering guarantees, `Map` key collisions, partial failures in
  bulk operations, pagination/limit boundaries.
- **Equivalence-class probe**: don't just test the boundary instance — ask whether the whole
  *class* of inputs it represents behaves consistently, and whether the same input behaves
  differently under a different config/flag value.

### Lens 3 — Business-rule & discrepancy (vs intent)
- Does the change preserve every domain rule stated in the ticket/wiki? Name the rule and the line
  that violates it.
- Discrepancy between what the ticket asked for and what the code does (over-reach or under-reach).
- Implicit rules made wrong: a threshold, an eligibility check, a routing/decision rule — especially
  wherever this domain has known non-obvious business-logic hotspots.
- **Letter-vs-spirit check**: the code may satisfy the ticket's literal wording while violating its
  intent (over-reach or under-reach) — verify against the *spirit* of the requirement, not just the
  acceptance criterion as written.

### Lens 4 — Regression risk (impact analysis / RTS)
- Which existing behaviors does this change alter? For each, is there a test asserting the *old*
  behavior that will now fail — or worse, one that will silently pass because it never covered it?
- **Mutation-adequacy lens**: treat the changed lines as a mutant. If you reverted or slightly
  altered a changed line, would *any* existing test fail? If not, the change is under-covered — say so.
- Cross-service ripple: changed DTO/contract/payload consumed by another service (trace it).

### Lens 5 — Concurrency & state
- New shared mutable state, race conditions, non-atomic read-modify-write, ordering assumptions.
- Idempotency: does re-delivery / retry / replay now double-apply or corrupt state?
- Non-determinism (uncontrolled time/random/iteration order) affecting outputs.

### Lens 6 — Oracle-hard correctness (metamorphic relations)
When there is no obvious expected output, reason with **metamorphic relations** — invariants that
must hold across related inputs (e.g. reordering inputs must not change the decision; scaling input
X should relate to output predictably; a filtered subset must not produce more results than the
whole). Flag any change that could violate such an invariant.

### Lens 7 — Failure & degradation paths
- External dependency timeout / unavailability / partial response (datastore, queue, cache,
  downstream service): does the change degrade gracefully or crash / lose data?
- Error messages/codes that changed and would mislead operators or break consumers parsing them.
- **Assumed-dependency probe**: name every dependency the code assumes is present (a lock, a DB, an
  upstream service, guaranteed ordering) — what happens when it is absent or degraded instead?
