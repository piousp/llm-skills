# Postable vs silent examples

All code is generic. Each case shows the printed item or the silent gate. Use these to calibrate close calls; they fix the discipline, not a bug taxonomy. If an item only matches an example and no changed line supports it, drop it.

## Posted

### 1. Removed assertion (R1, M)

Diff deletes `assertEquals(Status.ARCHIVED, dto.status());` from `WidgetMapperTest.mapsArchivedWidget`; the other assertions check only `id` and `name`.

```
1. [M] WidgetMapperTest.java:42: Should we keep asserting the status? Nothing else in this test fails if the mapper stops copying it.
   Change: `assertEquals(Status.ARCHIVED, dto.status())`
   Evidence: removing the `status` copy in WidgetMapper.map (line 18) keeps every remaining assertion green.
```

### 2. Sibling helper missing (R3, I)

`copiesToSecondRegion` is new; the three tests above it end with `assertSourceUntouched(source)`, the new one does not.

```
1. [I] WidgetCopyTest.java:77: Should this also call the helper the other copy tests use?
   Change: `assertSourceUntouched(source)`
   Evidence: sibling tests copiesToSameRegion, copiesWithPrefix, copiesEmpty all end with it.
```

### 3. Brittle foreign message (R4, I)

The test asserts the full text of a JSON parser's error message.

```
1. [I] ConfigLoaderTest.java:31: Could we assert the exception type and the one fragment we own instead of the parser's whole message?
   Change: `assertThrows(JsonParseException.class, ...)` plus `assertTrue(e.getMessage().contains("schemaVersion"))`
   Evidence: a parser upgrade that rewords the message fails this test with the code unchanged.
```

### 4. Critical gap (R5, G)

The diff adds `if (request.isDryRun()) return preview(request);` to `WidgetService.submit`; the test class only submits real requests.

```
G1. WidgetService.java:58: The new dry-run branch has no test. Should we add one?
    Test: `submitDryRunReturnsPreviewAndStoresNothing`: request with dryRun=true -> preview returned, `repository.save` never reached
```

### 5. Calibration question (R6, Question)

An integration test changes `sleep(500)` to a 250 ms poll with a 45 s cap and the comment "TTL is short".

```
1. [Question] ReplayIT.java:120: Can we get a few runs to confirm 250 ms / 45 s? The comment says the TTL is short but gives no number.
   Change: `POLL_MS = 250`, `MAX_WAIT_S = 45`
   Evidence: values changed in this diff with no run data attached.
```

### 6. Config key missing in test resources (R9, Question)

The diff adds `widget.batch.size` to `src/main/resources/application.yaml`.

```
1. [Question] application.yaml:14: Do we need `widget.batch.size` in the test resources too?
   Change: `widget.batch.size: 10` in `src/test/resources/application.yaml`
   Evidence: the new `@Value("${widget.batch.size}")` has no default and no test-side value.
```

## Silent

### 7. Smoke test, behavior covered elsewhere (G-C)

`builderCreatesClient` asserts only `assertNotNull(client)`. Another test in the file asserts the client's retry count and endpoint. No changed production line depends on this test alone. Silent: G-C.

### 8. Reflection and real-method mocks (G-C)

A test sets a private field by reflection and mocks a collaborator with `CALLS_REAL_METHODS`. No named mutation of a changed line escapes it. Silent: G-C.

### 9. Polling in a unit spec (G-C, waits rule)

A Scala spec wraps an assertion in `eventually { ... }` to wait for an actor message. Unit-test waits are never reported. Silent: G-C.

### 10. Pattern copied from the same file (G-D)

The new test uses `assertThrows(Exception.class, ...)`; five older tests in the file do the same. Silent: G-D.

### 11. Negative wait in a unit test (G-C)

`verify(handler, after(2000).never()).accept(any())` in a unit test. Silent: G-C. (In an integration test, a changed window that is the only guard of the changed behavior would be a Question, never M.)

### 12. Production style issue with fine tests (lane discipline)

The diff has a poorly named local variable in production code and a test that asserts the new boundary exactly. The naming issue belongs to `code-review-checklist`. Silent: outside this lens.

### 13. Tooling script not run in CI (G-E)

A helper script under `tools/` has no test and no CI entry. Silent: G-E.

### 14. Seven untested paths, one kept (G-G)

A new class has seven public methods and no test class. Print 1 gap, chosen by the Gap ranking keys: a method with zero tests beats a partly tested one; ties go to the earliest changed line. The rest are dropped without a "filtered" section.
