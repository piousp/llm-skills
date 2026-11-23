# When to Mock

[ALWAYS] mock at **system boundaries** only. A boundary is the project's adapter to something outside the process; mock the adapter, never what sits behind it:

- External APIs: the HTTP or SDK client (payment, email, etc.)
- Databases: the repository or DAO; the repository's own tests run against a test database, following the repo's integration-test conventions
- Time and randomness: the clock and the random source
- File system: the wrapper that reads or writes files, when a temp directory won't do

[DO NOT] mock:

- The project's own classes or modules (domain logic, services), except the adapters listed above
- Internal collaborators
- Anything else under the project's control

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

1. **Use dependency injection**: pass external dependencies in rather than creating them internally.
2. **Prefer SDK-style interfaces over generic fetchers**: create specific functions for each external operation instead of one generic function with conditional logic. Each mock then returns one specific shape, with no conditional logic in test setup; it is easier to see which endpoints a test exercises, and each endpoint gets type safety.

## Code Examples

See [`examples/mocking.java.md`](../examples/mocking.java.md) and [`examples/mocking.scala.md`](../examples/mocking.scala.md).
