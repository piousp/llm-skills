import { test } from "node:test";
import assert from "node:assert/strict";
import { needsExtensionBinding, SUBAGENT_TOOL_NAME } from "../../src/extension-binding.ts";

test("needsExtensionBinding: only built-in tools (origin top-level) returns false", () => {
  const tools = [
    { name: "read", sourceInfo: { origin: "top-level" as const, source: "builtin" } },
    { name: "bash", sourceInfo: { origin: "top-level" as const, source: "builtin" } },
  ];

  assert.equal(needsExtensionBinding(tools), false);
});

test("needsExtensionBinding: a tool with origin package (e.g. mcp, mde_build_mvn) returns true", () => {
  const tools = [
    { name: "read", sourceInfo: { origin: "top-level" as const, source: "builtin" } },
    { name: "mcp", sourceInfo: { origin: "package" as const, source: "pi-mcp-adapter" } },
  ];

  assert.equal(needsExtensionBinding(tools), true);
});

test("needsExtensionBinding: a top-level extension tool (not an installed package) returns false", () => {
  const tools = [
    { name: "custom-tool", sourceInfo: { origin: "top-level" as const, source: "local" } },
  ];

  assert.equal(needsExtensionBinding(tools), false);
});

test("needsExtensionBinding: an SDK custom tool (origin top-level) returns false", () => {
  const tools = [
    { name: "custom-tool", sourceInfo: { origin: "top-level" as const, source: "sdk" } },
  ];

  assert.equal(needsExtensionBinding(tools), false);
});

test("needsExtensionBinding: empty tool set returns false", () => {
  assert.equal(needsExtensionBinding([]), false);
});

test("needsExtensionBinding: a mix of built-ins plus one package tool returns true", () => {
  const tools = [
    { name: "read", sourceInfo: { origin: "top-level" as const, source: "builtin" } },
    { name: "bash", sourceInfo: { origin: "top-level" as const, source: "builtin" } },
    { name: "mcp", sourceInfo: { origin: "package" as const, source: "pi-mcp-adapter" } },
  ];

  assert.equal(needsExtensionBinding(tools), true);
});

test("needsExtensionBinding: the package's own subagent tool (origin package) is excluded — an agent that can nest subagents does not by itself need MCP", () => {
  const tools = [
    { name: SUBAGENT_TOOL_NAME, sourceInfo: { origin: "package" as const, source: "pi-simple-agents" } },
    { name: "read", sourceInfo: { origin: "top-level" as const, source: "builtin" } },
  ];

  assert.equal(needsExtensionBinding(tools), false);
});

test("needsExtensionBinding: a real MCP tool alongside the subagent tool still returns true (subagent exclusion doesn't mask other package tools)", () => {
  const tools = [
    { name: SUBAGENT_TOOL_NAME, sourceInfo: { origin: "package" as const, source: "pi-simple-agents" } },
    { name: "mcp", sourceInfo: { origin: "package" as const, source: "pi-mcp-adapter" } },
  ];

  assert.equal(needsExtensionBinding(tools), true);
});
