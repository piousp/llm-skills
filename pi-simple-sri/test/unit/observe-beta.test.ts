import { test } from "node:test";
import assert from "node:assert/strict";
import { betaUpperTail, decayedWeight } from "../../src/observe/beta.ts";

// The arithmetic under the recurrence threshold: the posterior tail of Beta(a, b) and the half-life. Reference values
// are closed forms, not outputs of the code: for integer a and b, I_x(a, b) = P(Binomial(a + b - 1, x) >= a), and the
// small cases reduce to polynomials (I_x(1, b) = 1 - (1 - x)^b, I_x(a, 1) = x^a).

const EPSILON = 1e-9;

function assertClose(actual: number, expected: number, epsilon = EPSILON): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);
}

test("betaUpperTail: the uniform prior has tail 1 - x", () => {
  assertClose(betaUpperTail(0.15, 1, 1), 0.85);
  assertClose(betaUpperTail(0.5, 1, 1), 0.5);
});

test("betaUpperTail: Beta(2, 1) has cdf x^2", () => {
  assertClose(betaUpperTail(0.15, 2, 1), 1 - 0.15 ** 2);
});

test("betaUpperTail: Beta(3, 1) has cdf x^3", () => {
  assertClose(betaUpperTail(0.15, 3, 1), 1 - 0.15 ** 3);
});

test("betaUpperTail: Beta(1, 3) has tail (1 - x)^3", () => {
  assertClose(betaUpperTail(0.15, 1, 3), 0.85 ** 3);
});

test("betaUpperTail: Beta(2, 2) has cdf 3x^2 - 2x^3", () => {
  const x = 0.15;
  assertClose(betaUpperTail(x, 2, 2), 1 - (3 * x ** 2 - 2 * x ** 3));
});

test("betaUpperTail: a symmetric Beta(a, a) has tail 1/2 at x = 1/2", () => {
  for (const a of [1, 2, 3.5, 10, 40]) assertClose(betaUpperTail(0.5, a, a), 0.5, 1e-8);
});

test("betaUpperTail: a larger case agrees with the binomial identity", () => {
  // P(Beta(3, 9) > 0.15) = P(Binomial(11, 0.15) <= 2)
  const q = 0.85;
  const p = 0.15;
  const expected = q ** 11 + 11 * p * q ** 10 + 55 * p ** 2 * q ** 9;
  assertClose(betaUpperTail(0.15, 3, 9), expected, 1e-9);
});

test("betaUpperTail: a non-integer shape stays inside [0, 1] and falls as x grows", () => {
  const low = betaUpperTail(0.1, 1.7, 4.2);
  const high = betaUpperTail(0.6, 1.7, 4.2);
  assert.ok(low > high);
  assert.ok(low <= 1 && high >= 0);
});

test("betaUpperTail: the ends of the support", () => {
  assert.equal(betaUpperTail(0, 2, 3), 1);
  assert.equal(betaUpperTail(-0.1, 2, 3), 1);
  assert.equal(betaUpperTail(1, 2, 3), 0);
  assert.equal(betaUpperTail(1.5, 2, 3), 0);
});

test("betaUpperTail: a shape that is not positive is refused instead of answered", () => {
  assert.throws(() => betaUpperTail(0.15, 0, 1), RangeError);
  assert.throws(() => betaUpperTail(0.15, 1, -2), RangeError);
  assert.throws(() => betaUpperTail(0.15, Number.NaN, 1), RangeError);
});

test("decayedWeight: the half-life is 90 days", () => {
  assertClose(decayedWeight(1, 90), 0.5);
  assertClose(decayedWeight(1, 180), 0.25);
  assertClose(decayedWeight(0.8, 90), 0.4);
});

test("decayedWeight: a fresh observation keeps its weight, and an age in the future does not amplify it", () => {
  assert.equal(decayedWeight(0.6, 0), 0.6);
  assert.equal(decayedWeight(0.6, -5), 0.6);
});

test("decayedWeight: a zero weight stays zero", () => {
  assert.equal(decayedWeight(0, 30), 0);
});
