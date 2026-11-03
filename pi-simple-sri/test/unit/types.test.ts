import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNever } from "../../src/types.ts";

// assertNever is the end of the two dispatches over ProposeFlowResult (src/command-skill-improve.ts and
// src/tool-skill-improve.ts). Its parameter is `never`, which is the compile-time half of the rule: a
// variant added to the union leaves the value of a dispatch that forgot it narrowed to that variant, so
// the call stops compiling. This test is the runtime half.
test("assertNever: a variant the union does not have is refused with its value", () => {
  // The argument is wrong on purpose, and the directive marks the one line where it is: no value of an
  // exhaustively handled union reaches this call, and the case the guard exists for -- a caller built
  // against an older union, sending a variant the compiled one no longer has -- has no other shape.
  // @ts-expect-error a variant outside every union of this package
  assert.throws(() => assertNever("accept"), /unhandled variant: "accept"/);
});
