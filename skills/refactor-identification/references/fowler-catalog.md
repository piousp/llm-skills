# Fowler Catalog Mapping

Every refactoring in refactoring.com/catalog mapped to its owner in this skill family, or to the
`pablo-code-philosophy` principle that excludes it. Check here before treating a catalog item as
an uncovered gap. This file is reference material, not a detection table: the rows that detect
candidates still live in `SKILL.md`'s A1-A4 tables and in `pablo-code-simplify`'s gate.

| Refactoring | Owner / exclusion |
|---|---|
| Change Function Declaration | `pablo-code-simplify` gate, internal-signature tier |
| Change Reference to Value | A3 "Shared mutable reference used as a value" |
| Change Value to Reference | Excluded unless real entity identity exists (FP.md, "structural equality is not identity"); default is value |
| Collapse Hierarchy | A1 "Inheritance used for reuse, not variation" |
| Combine Functions into Class | Excluded unless shared mutable state is real (GoF vs FP conflict row, `pablo-code-philosophy`) |
| Combine Functions into Transform | `functional-programming` (composition/pipeline) |
| Consolidate Conditional Expression | `pablo-code-simplify` gate, mechanical (precondition: preserves short-circuit order) |
| Decompose Conditional | `pablo-code-simplify` gate, mechanical |
| Encapsulate Collection | A2 "Mutable internals escaping" |
| Encapsulate Record | Excluded when already an immutable record/case class (KISS, ceremony); owner is A2 otherwise |
| Encapsulate Variable | A2 (general encapsulation) / `pablo-code-simplify` gate, mechanical for a local |
| Extract Class | A1 "SRP violation in a touched class" |
| Extract Function | `pablo-code-simplify` gate, mechanical |
| Extract Superclass | Excluded outside a sealed ADT (SOLID.md, composition over inheritance) |
| Extract Variable | `pablo-code-simplify` gate, mechanical |
| Hide Delegate | A2 "Read-through delegate chain" |
| Inline Class | `pablo-code-simplify` gate, mechanical ("inline a non-exported class") |
| Inline Function | `pablo-code-simplify` gate, mechanical |
| Inline Variable | `pablo-code-simplify` gate, mechanical (precondition: expression is pure and cheap) |
| Introduce Assertion | Excluded: not mechanically behavior-preserving; a proposed one is "Not mechanical" in simplify |
| Introduce Parameter Object | A3 "Data clump" |
| Introduce Special Case (Null Object) | A3 "null as domain absence", constrained to Option/Either or a value naming a real domain case; never a bare placeholder (KISS.md, "every value must name a domain case") |
| Move Field | A1 "Misplaced logic (feature envy)"; `pablo-code-simplify` internal-signature tier if private |
| Move Function | A1 "Misplaced logic (feature envy)" |
| Move Statements into Function | `pablo-code-simplify` gate, mechanical |
| Move Statements to Callers | `pablo-code-simplify` gate, mechanical |
| Parameterize Function | A1 "Structural duplication" |
| Preserve Whole Object | A3 "Data clump" (inverse direction) |
| Pull Up Constructor Body | Excluded outside a sealed ADT (composition over inheritance) |
| Pull Up Field | Excluded outside a sealed ADT |
| Pull Up Method | Excluded outside a sealed ADT |
| Push Down Field | A1 "Inheritance used for reuse, not variation" |
| Push Down Method | A1 "Inheritance used for reuse, not variation" |
| Remove Dead Code | `pablo-code-simplify` gate, mechanical (precondition: unreachability proven in-radius, else N9) |
| Remove Flag Argument | A4 "Boolean parameter selects behavior" |
| Remove Middle Man | `pablo-code-simplify` gate, mechanical + philosophy axis-list (over-abstraction) |
| Remove Setting Method | A2 (invariant rows) |
| Remove Subclass | A1 "Inheritance used for reuse, not variation" |
| Rename Field | `pablo-code-simplify` gate, mechanical (non-exported); N8 if proposed to refid directly |
| Rename Variable | `pablo-code-simplify` gate, mechanical |
| Replace Command with Function | Excluded unless shared mutable state or undo is real (GoF vs FP conflict row) |
| Replace Conditional with Polymorphism | A4, constrained to a sealed ADT + pattern match; never an open subclass hierarchy (SOLID.md) |
| Replace Constructor with Factory Function | A2 "Invariant bypassed by mutator" / `gof-design-patterns` Factory Method row |
| Replace Control Flag with Break | `pablo-code-simplify` gate, mechanical |
| Replace Derived Variable with Query | A3 "Redundant derived field" |
| Replace Error Code with Exception | Excluded: FP.md typed-error handling goes the other direction (exception/error code → Either) |
| Replace Exception with Precheck | A3 "Exceptions as control flow" |
| Replace Function with Command | Excluded unless shared mutable state or undo is real (GoF vs FP conflict row) |
| Replace Inline Code with Function Call | A1 "Structural duplication" / `pablo-code-simplify` gate, mechanical |
| Replace Loop with Pipeline | `pablo-code-simplify` gate, mechanical (precondition: preserves laziness/short-circuit/exception timing) + `functional-programming` |
| Replace Magic Literal | `code-review-checklist` "Config vs Code" |
| Replace Nested Conditional with Guard Clauses | `pablo-code-simplify` gate, mechanical |
| Replace Parameter with Query | `pablo-code-simplify` internal-signature tier, only when the query is pure over the same object |
| Replace Primitive with Object | A3 "Primitive obsession" |
| Replace Query with Parameter | A2 "Hidden dependency on ambient state" |
| Replace Subclass with Delegate | A1 "Inheritance used for reuse, not variation" |
| Replace Superclass with Delegate | A1 "Inheritance used for reuse, not variation" |
| Replace Temp with Query | `pablo-code-simplify` gate, mechanical (precondition: expression is pure and cheap) |
| Replace Type Code with Subclasses | A4, constrained to a sealed ADT; never an open subclass hierarchy (SOLID.md) |
| Return Modified Value | A2 "Query/mutator mixed (CQS violation)" |
| Separate Query from Modifier | A2 "Query/mutator mixed (CQS violation)" |
| Slide Statements | `pablo-code-simplify` gate, mechanical (precondition: no reordered side effect) |
| Split Loop | `pablo-code-simplify` gate, mechanical (precondition: no reordered side effect) |
| Split Phase | A1 "Mixed-phase function (no Split Phase)" |
| Split Variable | `pablo-code-simplify` gate, mechanical |
| Substitute Algorithm | Excluded: not mechanically behavior-preserving by definition; route a proposed swap to `qa-adversary` or a code-review pass |
