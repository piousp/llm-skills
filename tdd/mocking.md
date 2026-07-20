# When to Mock

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Databases (sometimes - prefer test DB)
- Time/randomness
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

1. **Use dependency injection** — pass external dependencies in rather than creating them
   internally.
2. **Prefer SDK-style interfaces over generic fetchers** — create specific functions for each
   external operation instead of one generic function with conditional logic. Each mock then
   returns one specific shape, with no conditional logic in test setup, it's easier to see which
   endpoints a test exercises, and you get type safety per endpoint.

## Code Examples

See [`examples/mocking.java.md`](examples/mocking.java.md) and [`examples/mocking.scala.md`](examples/mocking.scala.md).
