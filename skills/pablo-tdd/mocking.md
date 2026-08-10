# When to Mock

[ALWAYS] mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Databases (sometimes; prefer a test database)
- Time and randomness
- File system (sometimes)

[DO NOT] mock:

- The project's own classes or modules
- Internal collaborators
- Anything under the project's control

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

1. **Use dependency injection**: pass external dependencies in rather than creating them internally.
2. **Prefer SDK-style interfaces over generic fetchers**: create specific functions for each external operation instead of one generic function with conditional logic. Each mock then returns one specific shape, with no conditional logic in test setup; it is easier to see which endpoints a test exercises, and each endpoint gets type safety.

## Code Examples

See [`examples/mocking.java.md`](examples/mocking.java.md) and [`examples/mocking.scala.md`](examples/mocking.scala.md).
