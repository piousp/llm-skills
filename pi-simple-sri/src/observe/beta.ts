import { HALF_LIFE_DAYS } from "./types.ts";

// The arithmetic of the recurrence threshold, with no dependency: the upper tail of a Beta distribution through the
// regularized incomplete beta function (continued fraction of Lentz, as in Numerical Recipes 6.4).

const MAX_ITERATIONS = 300;
const PRECISION = 1e-14;
const TINY = 1e-300;

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

// ln Gamma(z) for z > 0.
function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const shifted = z - 1;
  let series = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i++) series += LANCZOS_COEFFICIENTS[i] / (shifted + i);
  const t = shifted + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

function continuedFraction(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < PRECISION) break;
  }
  return h;
}

// I_x(a, b), the cdf of Beta(a, b), for 0 < x < 1. The fraction converges fast below the mean; above it the symmetry
// I_x(a, b) = 1 - I_{1-x}(b, a) is used. Returns the complement when asked for the upper tail, so the tail is not
// computed as a difference of two numbers close to 1.
function incompleteBeta(x: number, a: number, b: number, upper: boolean): number {
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    const lower = (front * continuedFraction(x, a, b)) / a;
    return upper ? 1 - lower : lower;
  }
  const tail = (front * continuedFraction(1 - x, b, a)) / b;
  return upper ? tail : 1 - tail;
}

// P(X > x) for X ~ Beta(a, b): 1 - I_x(a, b).
export function betaUpperTail(x: number, a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) throw new RangeError(`Beta shape must be positive, got a=${a}, b=${b}`);
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  return Math.min(1, Math.max(0, incompleteBeta(x, a, b, true)));
}

// The weight after `ageDays`, halving every HALF_LIFE_DAYS. An age in the future (clock skew) does not amplify.
export function decayedWeight(weight: number, ageDays: number): number {
  return weight * 0.5 ** (Math.max(0, ageDays) / HALF_LIFE_DAYS);
}
