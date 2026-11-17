import { test } from "node:test";
import assert from "node:assert/strict";
import { firstObjectWhere, scanObjects } from "../../src/json-reply.ts";

// The shared reading of a model reply that holds one JSON object.

const isNamed = (value: unknown): value is { name: string } =>
  typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";

test("firstObjectWhere: a bare object is returned", () => {
  assert.deepEqual(firstObjectWhere('{"name":"a"}', isNamed), { name: "a" });
});

test("firstObjectWhere: prose and a code fence before the object are skipped", () => {
  assert.deepEqual(firstObjectWhere('Sure! ```json\n{"name":"a"}\n```', isNamed), { name: "a" });
});

test("firstObjectWhere: prose with a closing brace after the object does not break it", () => {
  assert.deepEqual(firstObjectWhere('{"name":"a"} and that is it }', isNamed), { name: "a" });
  assert.deepEqual(firstObjectWhere('{"name":"a"}\nNote: use {curly} braces } sparingly', isNamed), { name: "a" });
});

test("firstObjectWhere: a brace inside a string, escaped quotes included, does not end the object", () => {
  assert.deepEqual(firstObjectWhere('{"name":"a } \\" { b"}', isNamed), { name: 'a } " { b' });
});

test("firstObjectWhere: a candidate that does not parse or is not accepted is skipped for a later one", () => {
  assert.deepEqual(firstObjectWhere('{not json} {"other":1} {"name":"late"}', isNamed), { name: "late" });
});

test("firstObjectWhere: the first accepted object wins over a later one", () => {
  assert.deepEqual(firstObjectWhere('{"name":"first"} {"name":"second"}', isNamed), { name: "first" });
});

test("firstObjectWhere: an object that never closes is skipped, and null is the answer when nothing is accepted", () => {
  assert.deepEqual(firstObjectWhere('{"name":"open" ... {"name":"closed"}', isNamed), { name: "closed" });
  assert.equal(firstObjectWhere('{"name":"open"', isNamed), null);
  assert.equal(firstObjectWhere("no object here", isNamed), null);
  assert.equal(firstObjectWhere('{"other":1}', isNamed), null);
});

test("scanObjects: counts every opening brace and lists the balanced candidates", () => {
  assert.deepEqual(scanObjects("nothing"), { objects: [], starts: 0 });
  assert.deepEqual(scanObjects('{"a":1'), { objects: [], starts: 1 });
  assert.deepEqual(scanObjects('x {"a":1} y }'), { objects: ['{"a":1}'], starts: 1 });
});
