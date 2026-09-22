# UNIX - Design for Composition

## Maxim

> Design for composition. Be silent in success, loud in failure. Make state visible. Treat data as streams. Invest in tools.

## Rules

This file covers the Unix rules KISS, DRY, YAGNI, and SOLID don't already cover.

### Silence Is Golden

{BAD} a script that prints a status line on every successful step.
{GOOD} silent success; stdout carries only data, errors go to stderr, exit codes carry status.

- [ALWAYS] produce no output on success. [ALWAYS] send errors to stderr, data to stdout.
- [NEVER] make a caller consuming stdout parse noise to find the real output.

### Transparency

{BAD} a long-running job whose progress can't be observed without attaching a debugger.
{GOOD} a read-only snapshot method a health check or log line can call without changing
behavior.

- [ALWAYS] design for runtime visibility; execution paths must be observable - what happened,
  in what order, with what inputs.
- [ALWAYS] treat robustness as following from transparency, not from defensive coding.

### Fail Early, Fail Loud, Fail Close to the Cause

{BAD} an exception swallowed three layers down, surfacing as a confusing symptom higher up.
{GOOD} the error reported at the point of detection, specific and immediate.

- [ALWAYS] detect errors immediately, report them specifically, and stop.
- [NEVER] swallow exceptions or accumulate damage before reporting.

### Text Is the Universal Interface

{BAD} an ad-hoc format that needs a bespoke tool to inspect or transform.
{GOOD} one record per line, consistent delimiter, readable by a human and parseable by a program.

- [ALWAYS] communicate through text streams when throughput doesn't rule it out.
- [NEVER] require a special tool to inspect, transform, or redirect the output.

### Invest in Tools, Not Workarounds

{BAD} repeating the same manual workaround for a recurring task.
{GOOD} a temporary, disposable script that automates it.

- [ALWAYS] build a tool when a task recurs, even if temporary, ugly, or single-use.
- [ALWAYS] spend programmer time freely on automation; it's the expensive resource to save.

### Least Surprise

{BAD} a function named `getUser` that creates a user as a side effect.
{GOOD} `getUser` only reads; a separate `createUser` creates.

- [ALWAYS] do the least surprising thing in interface design; follow conventions.
- [NEVER] name a function to imply one behavior while it performs another (a `timeout`
  parameter in seconds when the convention is milliseconds, a list-returning function that
  returns null).

## Code Examples

See [`../../examples/unx.java.md`](../../examples/unx.java.md) and [`../../examples/unx.scala.md`](../../examples/unx.scala.md).

## Warnings

- [NEVER] confuse silence with no logging; silence means no output on success, errors must
  still be reported (`console.log` is noise, `console.error` is signal).
- [ALWAYS] make visibility opt-in for hot paths; transparency is not free.
- [NEVER] treat "fail early" as "crash on every validation error"; distinguish programmer
  errors (crash) from domain errors (return a result type).
- [ALWAYS] use binary when throughput matters; prefer text, don't worship it.
- [ALWAYS] treat disposable tools as legitimate investment, not yak-shaving; expect to throw
  some of them out.
- [ALWAYS] pair consistent naming with documentation; Least Surprise reduces the need for docs,
  it doesn't eliminate it.

## Related Principles

- **KISS** → See [KISS.md](KISS.md). Covered by the `UNIX vs KISS` row in [references/interactions.md](../interactions.md).
- **DRY** → See [DRY.md](DRY.md). Covered by the `DRY vs UNIX` row in [references/interactions.md](../interactions.md).
- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the `UNIX vs YAGNI` row in [references/interactions.md](../interactions.md).
- **SOLID** → See [SOLID.md](SOLID.md). Covered by the `UNIX vs SOLID` row in [references/interactions.md](../interactions.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs UNIX` row in [references/interactions.md](../interactions.md).
- **FP** → See [FP.md](FP.md). Covered by the `FP vs UNIX` row in [references/interactions.md](../interactions.md).
