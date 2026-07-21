# UNIX — Design for Composition

## Maxim

> Design for composition. Be silent in success, loud in failure. Make state visible. Treat data as streams. Invest in tools.

## Explanation

This file covers the Unix rules KISS, DRY, YAGNI, and SOLID don't already cover.

### Silence Is Golden

Success produces no output. Errors go to stderr. Exit codes carry status. stdout carries data. A caller consuming stdout should not need to parse noise.

### Transparency

Design for runtime visibility. Make state inspectable, loggable, dumpable — without side effects. Execution paths must be observable: what happened, in what order, with what inputs. Robustness follows from transparency, not defensive coding.

### Fail Early, Fail Loud, Fail Close to the Cause

Detect errors immediately, report them specifically, and stop. Don't swallow exceptions. Don't accumulate damage before reporting. A failure at the detection point is more informative than one three layers up.

### Text Is the Universal Interface

Design components to communicate through text streams. One record per line, consistent delimiter. Output a human can read and a program can parse. No special tools required to inspect, transform, or redirect.

### Invest in Tools, Not Workarounds

When a task recurs, build a tool. It can be temporary, ugly, single-use. The value is in the automation, not the tool's longevity. Programmer time is the expensive resource; spend cycles freely to save it.

### Least Surprise

In interface design, do the least surprising thing. A function named `getUser` must not create a user. A function returning a list must not return null. A parameter named `timeout` must be milliseconds, not seconds. Follow conventions. Predictable code needs no guesswork.

## Code Examples

See [`../examples/unx.java.md`](../examples/unx.java.md) and [`../examples/unx.scala.md`](../examples/unx.scala.md).

## Warnings

- **Silence does not mean no logging.** Silence means no output for success. Errors must be reported. `console.log` is noise; `console.error` is signal.
- **Transparency is not free.** Make visibility opt-in for hot paths.
- **"Fail early" does not mean "crash on every validation error."** Distinguish programmer errors (crash) from domain errors (return a result type).
- **Text is not always the right interface.** When throughput matters, use binary. Prefer text, don't worship it.
- **Investing in tools is not yak-shaving.** Disposable tools are fine. McIlroy: "expect to throw some of them out."
- **Least Surprise is not a substitute for documentation.** Consistent naming reduces the need, but does not eliminate it.

## Related Principles

- **KISS** → See [KISS.md](KISS.md)
- **DRY** → See [DRY.md](DRY.md)
- **YAGNI** → See [YAGNI.md](YAGNI.md)
- **SOLID** → See [SOLID.md](SOLID.md)