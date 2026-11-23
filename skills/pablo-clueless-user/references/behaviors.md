# Callers, channels and behaviors

Use with Process steps 3 and 4 of SKILL.md.

## Callers

| Caller | Reaches the change through | Knows only |
|---|---|---|
| API caller | public or internal HTTP routes, with curl, Postman or a script | route and parameter names, API docs, responses |
| Operator | admin and ops endpoints, CLIs, messages an operator can republish | runbooks, help text, sibling endpoints and tools |
| End user | a UI handler or form in the repo | labels, buttons, what the screen shows |
| Developer | a public function or class the diff adds or changes | name, signature, doc comment |

- [DO NOT] assume a UI constrains an API unless the constraint is in the repo. An API caller can
  send what the UI never would.
- A queue consumer or a scheduler fed only by other services has no human caller. An operator
  replay, retry or reprocess route in the repo makes it reachable.

## Entry-point signals

- Java, Spring MVC: `@RestController`, `@RequestMapping`, `@GetMapping`, `@PostMapping`,
  `@RequestParam`, `@PathVariable`, `@RequestBody`. Guards: typed binding (a non-numeric `int`
  param fails with 400), `@Valid`, `@Validated`, `@Min`, `@Max`, `@Pattern`.
- Scala, Akka HTTP (Pekko HTTP uses the same DSL): `path`, `pathPrefix`,
  `parameter("x".as[Int])`, `entity(as[T])`, `complete`. Guards: typed `.as[...]` and
  `entity(as[T])` decoding (rejected before the handler), `validate(...)`.
- Operator routes: names with `debug`, `replay`, `retry`, `reprocess` or `dlq`. Treat them as
  operator entry points even without docs or auth.
- CLIs: a `def main(args` or `public static void main(` that parses its arguments, scopt,
  picocli, `process.argv`, yargs, commander. A `main` that only boots a server is not a CLI.
- TS and JS: Express or Nest handlers (`router.post`, `@Post()`), Lambda handlers. Guards: zod,
  class-validator, io-ts.
- Public API for developers: `public` Java members, non-private Scala members, `export` in TS.

## What can reach the changed line

| Channel | Reachable | Dropped by construction |
|---|---|---|
| Typed function argument | every value of the declared type: `Int.MinValue` to `Int.MaxValue`, `""`, empty collections, any id string, swapped arguments of the same type, omitted defaults | any other type |
| Bound HTTP param (`int`, `Long`, enum, `LocalDate`) | every value of that type: negative, zero, huge, dates far in the past or future | text that fails the binding |
| String param, header, form field, CLI arg, env var | any text | nothing until a parse or a check runs |
| JSON body bound to a typed DTO | any value of each field's type; Spring Boot's Jackson setup and circe's derived decoders drop misspelled or extra fields, a bare `new ObjectMapper()` rejects them (check the config) | JSON types the binder rejects |
| Raw JSON (`Map`, `JsonNode`, `Json`, `any`, `unknown`) | anything | nothing |
| TS value at runtime | whatever was sent, unless a schema validates it | what the schema rejects |

## Probing an entry point

Enumerate the way `computeSize(x: Int)` gets probed, then filter with Reachability, the
Ownership test and the Evidence rule in SKILL.md. Most values below land in qa-adversary's
lanes. They are here to enumerate, not to report.

- **Values:** negative, zero, huge, `Int.MinValue`; an empty string or collection; whitespace; a
  value in the wrong unit, case, timezone or format; a date far in the past or future; another
  entity's id; another environment's id; a display name where an id goes; a partial name where
  an exact one is expected.
- **Combinations:** two flags that contradict each other; two arguments of the same type
  swapped; a filter that matches more than the caller meant.
- **Actions:** a step out of order; a step skipped; a flow abandoned midway (tab closed, command
  killed, timeout); a step repeated by hand; an old link, form or id reused after the state
  changed.
- **Reading:** a `200` or exit code `0` with errors in the body; a warning only in the logs; a
  message that suggests the wrong fix; dry-run output that reads like a real run.

## The five behaviors

### workflow

The caller runs a multi-step flow in an order nobody planned: a step out of order, skipped,
abandoned or redone.
- Probe: what state does each step leave if the next one never comes? What does each step do if
  the previous one failed or never ran?
- Owned here: state the code never checks from the caller's side. A hold or lock with no expiry,
  a step that runs after the previous one failed, a cancel accepted after the order shipped.
- qa-adversary's: internal operation order (lens 1), concurrent callers, races and machine
  retries (lens 5).

### after-error

The caller carries on after an error: ignores or misreads a response, retries the same thing,
treats a failed step as done, or follows a message into harm.
- Probe: after each error or partial failure, what does the caller see, and what is the natural
  next action?
- Owned here: a new response, message, status or exit code that sends the caller to a wrong next
  step.
- qa-adversary's: changed error codes or messages that break existing parsers or dashboards,
  dependency failures (lens 7), swallowed exceptions (lens 1).

### wrong-entity

An honest mix-up: another entity's id, another environment's id, a value meant for another
field. The code accepts it and acts on the wrong thing.
- Probe: if the caller pastes the id from the wrong screen or column, does anything fail?
- Owned here: code that resolves an id across entity types, falls back to a second lookup, or
  shares one id space, so the wrong id succeeds.
- qa-adversary's: ids probed on purpose to reach data the caller should not see (lens 8, IDOR);
  an id that matches nothing and crashes the code (lens 2).

### assumed-knowledge

The code assumes the caller knows what X is: the unit, the timezone, the format, which id, which
environment, that a name is unique, that only one match exists.
- Probe: what would a caller guess from the surface alone, and what happens with that guess?
- Owned here: an assumption the surface never states, where the natural guess gives a wrong
  result.
- qa-adversary's: wrong conversions inside the code (lens 2), rules written in the ticket or
  wiki (lens 3).

### misleading-default

An omitted parameter or a default value that is valid but does what the caller did not expect:
destructive, broad, or aimed at production.
- Probe: what happens when the caller sends only the required parameters?
- Owned here: a new default that breaks the convention the surface sets (sibling endpoints, help
  text, the parameter's name).
- qa-adversary's: a default the diff changes (lens 1), null or missing values that crash
  (lens 2).

## Boundary with qa-adversary, lens by lens

| qa-adversary lens | Skip | Can survive only as |
|---|---|---|
| 1 Logic | wrong conditions, off-by-one, changed defaults, internal operation order, early returns, swallowed exceptions, constraint inversion of the code's own logic (reversed input order, contradictory flags) | workflow: a caller-side order of steps the code never checks |
| 2 Data | null, empty, zero, negative, min or max, overflow, malformed or wrong-format values, conversion bugs, bulk partial failures, collection semantics | assumed-knowledge: a unit or format the surface never states; misleading-default: a valid value whose broad meaning the surface hides |
| 3 Business rule | rules written in the ticket or wiki; existing thresholds, eligibility checks and routing rules the diff changes | nothing |
| 4 Regression | changed behavior for existing callers and consumers | nothing |
| 5 Concurrency | concurrent callers, races, machine retries, redelivery, replay, idempotency | after-error: the caller repeats or changes a request because a response misled them, and an idempotency fix would not stop the harm |
| 6 Oracle | metamorphic relations, input-order invariants | nothing |
| 7 Degradation | dependency failures, changed error messages and codes | after-error: a new response that sends the caller to a wrong next step |
| 8 Security | injection, IDOR, auth, data exposure, any crafted input | wrong-entity: an honest mix-up the code accepts and acts on |

Every "can survive" entry still needs both halves of the Ownership test: a caller-side cause and
a fix qa-adversary would not ask for. qa-adversary lists operator misuse of an internal endpoint
as a doubt; here it is in lane and becomes a Finding when it meets the Evidence rule.
