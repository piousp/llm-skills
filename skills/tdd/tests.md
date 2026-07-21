# Good and Bad Tests

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on call counts/order
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means instead of interface

**Bypassing the interface to verify**: querying the database or another side channel instead of
using the public interface the caller would use.

**Tautological tests**: Expected value restates the implementation, so the test passes by
construction. Expected values must come from an independent, known-good source (a literal, a
worked example, the spec) — never recomputed the way the code computes it.

## Code Examples

See [`examples/tests.java.md`](examples/tests.java.md) and [`examples/tests.scala.md`](examples/tests.scala.md).
