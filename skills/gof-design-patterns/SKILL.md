---
name: gof-design-patterns
description: >
  Curated GoF design-pattern guidance (Gamma/Helm/Johnson/Vlissides, 1994) for Java and Scala.
  Covers 12 patterns: Strategy, Factory Method, Builder, Decorator, Adapter,
  Template Method, Observer, Chain of Responsibility, Composite, State, Visitor, Command. TRIGGER
  when: reviewing/designing a class hierarchy that varies behavior by subclassing, refactoring a
  growing switch/if-else that selects an algorithm or builds/wraps an object step by step,
  reviewing event/listener/callback wiring, designing a request/undo/queue abstraction, or when
  the user names any of the 12 patterns or asks for a design-pattern review. Provides a
  code-smell → pattern table AND a when-NOT-to-apply table (over-engineering, or redundant given
  Scala's traits/case classes/pattern matching), cross-referenced against `functional-programming`
  and `pablo-code-philosophy`. SKIP: the other 11 GoF patterns (Abstract Factory, Prototype,
  Singleton, Bridge, Facade, Flyweight, Proxy, Interpreter, Iterator, Mediator, Memento).
---

# GoF Design Patterns — Curated Catalog

Mechanical companion to `pablo-code-philosophy`'s "Don't reinvent the wheel: follow known design
patterns" principle. That skill states the principle in one line; this skill provides the
recognition heuristics, the per-language idioms, and the worked pattern catalog needed to apply it
correctly in Java and Scala service code.

A design pattern is a name for a recurring shape, not a goal to hit. Every section below exists to
help you recognize when reaching for one of these 12 patterns pays off — and, just as importantly,
when it doesn't. Applying a pattern where the simpler code would do is the same mistake as not
applying one where the messy code needs it; `pablo-code-philosophy`'s "No speculative
abstractions" principle applies to patterns exactly as it applies to any other abstraction.

## Scope: why these 12 and not all 23

The original catalog has 23 patterns across three categories. This skill deliberately covers a
curated subset — the patterns that recur in typical Java/Scala service code — rather than the full
catalog. The other 11 are either redundant given Scala's language features, ceremony for problems
these codebases don't have, or simply haven't come up; see "Boundaries" at the end for the full
list and reasoning. If a real need for one of them arises, that's a design decision to raise
explicitly, the same way `functional-programming`'s Boundaries section treats adding an FP library.

| Category | Patterns covered here |
|---|---|
| Creational | Factory Method, Builder |
| Structural | Adapter, Decorator, Composite |
| Behavioral | Strategy, Template Method, Observer, Chain of Responsibility, State, Visitor, Command |

## Recognition heuristic: code smell → pattern

Use this table when reviewing or designing code to decide *which* pattern, if any, addresses what
you're looking at. Each row names the smell, not the pattern, on purpose — recognize the shape
first, then reach for the name.

| Code smell | Pattern | Why |
|---|---|---|
| A switch/if-else chain selects among several interchangeable algorithms or behaviors, and the set is expected to grow | Strategy | Encapsulating each algorithm behind a shared interface replaces branching with substitution; each variant becomes independently testable and addable without touching the others. |
| A constructor takes many optional parameters, and callers assemble the object via telescoping constructors or a long argument list where most calls only set a few fields | Builder | A builder makes required-vs-optional assembly explicit and lets you validate the combination before `build()`, instead of relying on argument position or overload resolution. |
| A method decides which concrete subclass to instantiate based on a parameter/config, and that decision is duplicated at several call sites | Factory Method | Centralizing construction means callers depend on the abstraction, not on `new ConcreteX()` scattered through the codebase — one place to change when a new variant is added. |
| Behavior needs to be layered onto an object at runtime (logging, caching, retrying) without an explosion of subclasses for every combination | Decorator | Wrapping the base implementation with same-interface layers composes behaviors instead of requiring one subclass per combination. |
| An external or legacy API's interface doesn't match what the calling code expects, and call sites each repeat their own translation logic | Adapter | One conversion class isolates the mismatch instead of repeating translation at every call site — the rest of the code depends on the shape it actually wants. |
| Several classes implement the same overall algorithm skeleton but override a few specific steps, and the skeleton itself is copy-pasted with only the steps differing | Template Method | Moving the invariant skeleton to a shared base/trait and letting subclasses fill in only the varying steps removes the duplicated scaffolding. |
| Several unrelated parts of the code need to react when some state changes (a status flips, a job completes), currently wired via manual polling or direct calls sprinkled through the code that changes | Observer | Decoupling the subject from what reacts to it lets new listeners be added without modifying the subject every time. |
| A validation/handling sequence is a long if-else where each branch decides to handle the request or delegate to "the next" check, and which checks apply changes with config | Chain of Responsibility | Each handler decides handle-or-pass-on independently; the chain's composition becomes data (a list of handlers) instead of a hardcoded nested conditional. |
| A tree-like structure (a menu, a document, a filter expression) is manipulated with type-checks distinguishing "leaf" from "group of children" at every call site | Composite | Giving leaf and composite nodes the same interface means client code walks the tree uniformly instead of special-casing grouping everywhere it appears. |
| An object's behavior changes completely depending on an internal mode/status field, and that field is checked at the top of nearly every method | State | Representing each mode as its own type implementing the shared behavior makes the transition itself explicit, instead of implicit in scattered if-chains on the mode field. |
| A recursive/tree data structure needs a growing set of unrelated operations applied over it (render, validate, export), each currently requiring another type-check cascade added to every node type | Visitor | Adding a new operation without modifying the node classes — though in Scala this is usually replaced outright by pattern matching over a sealed hierarchy; see `references/scala.md` before reaching for a real Visitor. |
| Client code builds a request/action object just to invoke it later, undo it, retry it, or put it on a queue | Command | Encapsulating a request as an object lets it be queued, logged, retried, or undone independently of whatever triggered it. |

## When NOT to apply a pattern

A pattern applied where it doesn't fit reads as ceremony, not clarity — the same failure mode
`functional-programming`'s anti-pattern table describes for FP. Check this table before reaching
for a pattern above.

| Situation | Why the pattern hurts here |
|---|---|
| Only one implementation exists, with no concrete plan for a second one | Strategy, Factory Method, and Template Method all add an interface and indirection for a variation that doesn't exist yet — this is exactly the "no imaginary flexibility" case in `pablo-code-philosophy`. |
| The object has 2-3 required constructor parameters and no optional/conditional assembly logic | A Builder is ceremony over a plain constructor — or, in Scala, over a case class with named/default parameters; see `references/scala.md`. |
| The "family of algorithms" is really just a couple of pure functions with no shared state or lifecycle | A Strategy class hierarchy is heavier than passing a function value directly. This is `functional-programming`'s higher-order-function case — don't build a class where a `Function<A,B>`/`A => B` parameter suffices. |
| The tree/hierarchy is already modeled in Scala as a `sealed trait` + case classes | Visitor's double-dispatch machinery reproduces what `match` over a sealed hierarchy already gives you, with the compiler's exhaustiveness check as a bonus — see `references/scala.md`. Don't layer a Visitor on top of an ADT that already pattern-matches cleanly. |
| State transitions are simple and few (one boolean flag, two states) | A full State-pattern class-per-state adds more boilerplate than a plain enum/sealed trait with a `match`/`switch`. Reserve State for when per-state behavior and transition logic have genuinely grown complex. |
| A single listener reacts to a single event with no plan for a second listener | Observer's subject/listener registration machinery is unneeded indirection over a direct method call. |
| Wrapping only ever happens one layer deep, with no plan to compose further decorators | A plain wrapper method or class is as clear as a Decorator interface for one fixed wrapping; the pattern earns its cost only when layers actually combine. |

If a smell from the recognition table is present but the situation also matches a row here,
default to the simpler code — don't apply a pattern reflexively. This mirrors
`pablo-code-philosophy`'s "Composition over inheritance" and "No speculative abstractions"
principles: patterns are a tool for handling *real* variation, not a checklist to satisfy.

## Per-language mechanics

The patterns above are language-agnostic in intent; several of them collapse into a language
feature in Scala where Java still needs the full class-based structure. Read the file for the
language you're touching:

- **Java** → `references/java.md`. Covers the classic interface/abstract-class implementation of
  each pattern, and where Java 17 `record`/`sealed interface` simplify the data-carrier side of a
  pattern (check the target repo's `pom.xml` `java.version` first, per the existing
  build-aware-codegen rule — many repos in a multi-service codebase are still on Java 8/11).
- **Scala** → `references/scala.md`.
  Covers which patterns are largely subsumed by `sealed trait`/case classes/pattern matching/
  function values, and the idiomatic Scala shape for the ones that still earn their keep.

## Pattern catalog

`references/patterns.md` has worked before/after examples, in both languages, for all 12 patterns:
the smell-driven starting point and the pattern-applied result, with a "when this is worth it"
note per pattern. Read it when implementing one of these shapes rather than re-deriving the
structure from the recognition table each time.

## Boundaries (explicitly out of scope)

This skill covers 12 of the 23 GoF patterns. The remaining 11 are deliberately excluded:

| Pattern | Why excluded |
|---|---|
| Singleton | DI (Spring beans in Java services, composition-root wiring in Scala services) or a plain Scala `object` already meets the "shared instance" need; a hand-rolled Singleton adds global-state risk (`pablo-code-philosophy`'s "Scientific code") for no benefit. |
| Abstract Factory | Only worth it when whole *families* of related objects must vary together as a unit — no codebase here has that shape; plain Factory Method covers today's construction-indirection need. |
| Prototype | Solves a cost-of-construction problem these codebases don't have; a constructor or Builder is simpler when construction is cheap. |
| Bridge | Real complexity-management for GUI toolkit-style variation, not service/data-pipeline code; introducing it speculatively is "imaginary flexibility". |
| Facade | A well-named service class wrapping a subsystem already gives you this — any "orchestrator method sequencing N steps" already is one. |
| Flyweight | Memory-optimization for very large numbers of fine-grained objects; no data volume in this codebase makes this a real constraint today. |
| Proxy | The lazy-loading/access-control/remote-object need is already met by a client class, a caching layer, or framework-level AOP (e.g., Spring); a hand-rolled Proxy duplicates existing infrastructure. |
| Interpreter | For building little languages/expression evaluators; no repo here defines or evaluates its own grammar. |
| Iterator | Fully subsumed by Java's enhanced `for`/`Iterable` and Scala's collections library; a custom `Iterator` is essentially never justified in either language. |
| Mediator | Many-to-many object communication is already handled at the architecture level by the messaging/queue infrastructure these services use; a Mediator *class* rarely adds value inside a single service. |
| Memento | Undo/snapshot-restore for long-lived, user-undoable in-memory state; none of these services hold that kind of state. |

Don't introduce one of these 11 to reach for a shape covered in this skill — if a real need for one
surfaces, raise it explicitly as a design decision rather than reaching for it silently mid-task.
