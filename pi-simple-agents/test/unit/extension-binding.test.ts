import { test } from "node:test";
import assert from "node:assert/strict";
import { needsExtensionBinding, SUBAGENT_TOOL_NAME, type ToolSource } from "../../src/extension-binding.ts";

// Shapes mirror what pi 0.99's AgentSession.getAllTools() really returns:
// base tools and built-in extension tools are all origin "top-level" +
// source "builtin"; only sourceInfo.path tells them apart.
function builtinTool(name: string): ToolSource {
  return { name, sourceInfo: { path: `builtin:${name}`, origin: "top-level", source: "builtin" } };
}

function builtinExtensionTool(name: string, extension: string): ToolSource {
  return { name, sourceInfo: { path: `builtin:${extension}`, origin: "top-level", source: "builtin" } };
}

function packageTool(name: string, source: string): ToolSource {
  return { name, sourceInfo: { path: `/pkgs/${source}/index.ts`, origin: "package", source } };
}

function localTool(name: string, source: string): ToolSource {
  return { name, sourceInfo: { path: `/ext/${name}.ts`, origin: "top-level", source } };
}

test("needsExtensionBinding: only base built-in tools returns false", () => {
  assert.equal(needsExtensionBinding([builtinTool("read"), builtinTool("bash")]), false);
});

test("needsExtensionBinding: a tool with origin package (an installed extension, e.g. pi-search-hub) returns true", () => {
  assert.equal(needsExtensionBinding([builtinTool("read"), packageTool("pkg_tool", "some-extension-package")]), true);
});

test("needsExtensionBinding: a top-level local extension tool returns false", () => {
  assert.equal(needsExtensionBinding([localTool("custom-tool", "local")]), false);
});

test("needsExtensionBinding: an SDK custom tool returns false", () => {
  assert.equal(needsExtensionBinding([localTool("custom-tool", "sdk")]), false);
});

test("needsExtensionBinding: empty tool set and no requested tools returns false", () => {
  assert.equal(needsExtensionBinding([]), false);
  assert.equal(needsExtensionBinding([], []), false);
});

test("needsExtensionBinding: the package's own subagent tool is excluded", () => {
  assert.equal(needsExtensionBinding([packageTool(SUBAGENT_TOOL_NAME, "pi-simple-agents"), builtinTool("read")]), false);
});

test("needsExtensionBinding: a real package tool alongside the subagent tool still returns true", () => {
  assert.equal(
    needsExtensionBinding([packageTool(SUBAGENT_TOOL_NAME, "pi-simple-agents"), packageTool("pkg_tool", "some-extension-package")]),
    true,
  );
});

for (const [name, extension] of [["tool_search", "tool-search"], ["codemode", "codemode"], ["mcp__srv__tool", "mcp"]] as const) {
  test(`needsExtensionBinding: a tool from the built-in ${extension} extension (path builtin:${extension}) returns true`, () => {
    assert.equal(needsExtensionBinding([builtinTool("read"), builtinExtensionTool(name, extension)]), true);
  });
}

test("needsExtensionBinding: a requested tool not registered yet (only an extension can supply it at session_start) returns true", () => {
  assert.equal(needsExtensionBinding([builtinTool("read")], ["read", "mcp__mde-build__mvn"]), true);
});

test("needsExtensionBinding: every requested tool already registered as a base built-in returns false", () => {
  assert.equal(needsExtensionBinding([builtinTool("read"), builtinTool("bash")], ["read", "bash"]), false);
});

test("needsExtensionBinding: requesting the subagent tool alone never triggers binding, registered or not", () => {
  assert.equal(needsExtensionBinding([builtinTool("read")], ["read", SUBAGENT_TOOL_NAME]), false);
});

test("needsExtensionBinding: inert Claude Code tools kept in agent.tools (Task, TodoWrite, ...) are never registered and never trigger binding", () => {
  assert.equal(needsExtensionBinding([builtinTool("read")], ["read", "Task", "TodoWrite"]), false);
});
