import { test } from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../../src/lru-cache.ts";

test("LruCache: a miss returns undefined and a hit returns the value", () => {
  const cache = new LruCache<string, number>(2);
  assert.equal(cache.get("a"), undefined);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
});

test("LruCache: inserting past the limit evicts the oldest entry", () => {
  const cache = new LruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
});

test("LruCache: a hit refreshes the entry so the next one is evicted", () => {
  const cache = new LruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
});

test("LruCache: setting an existing key replaces it, refreshes it and evicts nothing", () => {
  const cache = new LruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10);
  assert.equal(cache.get("b"), 2);
  cache.set("a", 11);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 11);
  assert.equal(cache.get("c"), 3);
});

test("LruCache: clear drops every entry", () => {
  const cache = new LruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), undefined);
});
