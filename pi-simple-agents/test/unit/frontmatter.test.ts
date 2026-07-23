import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../../src/frontmatter.ts";

test("valid frontmatter with all 4 Claude-Code fields parses into correct object and body", () => {
  const content = `---
name: my-agent
description: Does a thing
tools: read, grep
model: sonnet
---
# Body

Rest of the content.
`;
  const { frontmatter, body } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "my-agent");
  assert.equal(frontmatter.description, "Does a thing");
  assert.deepEqual(frontmatter.tools, ["read", "grep"]);
  assert.equal(frontmatter.model, "sonnet");
  assert.equal(body, "# Body\n\nRest of the content.\n");
});

test("tools list is split on comma and trimmed", () => {
  const content = `---
tools: read, grep, find
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.deepEqual(frontmatter.tools, ["read", "grep", "find"]);
});

test("content with no frontmatter block returns empty frontmatter and unchanged body", () => {
  const content = "# Just a heading\n\nNo frontmatter here.\n";
  const { frontmatter, body } = parseFrontmatter(content);

  assert.deepEqual(frontmatter, {});
  assert.equal(body, content);
});

test("unknown extra field is parsed but does not break known field extraction", () => {
  const content = `---
name: my-agent
description: Does a thing
foo: bar
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "my-agent");
  assert.equal(frontmatter.description, "Does a thing");
  assert.equal(frontmatter.foo, "bar");
});

test("inheritProjectContext false string is parsed as boolean false", () => {
  const content = `---
inheritProjectContext: false
---
body`;
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.inheritProjectContext, false);
  assert.equal(typeof frontmatter.inheritProjectContext, "boolean");
});
