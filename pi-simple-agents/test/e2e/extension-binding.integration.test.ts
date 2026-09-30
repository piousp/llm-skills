// Live integration test: creates a real AgentSession through the same
// loader a subagent gets (buildLoaderOptions + DefaultResourceLoader, which
// supplies pi's built-in codemode/tool-search/mcp extensions) — no `pi`
// subprocess, no prompt()/model call — and drives the exact
// gate -> bind -> shutdown sequence runAgentViaSdk uses (src/run.ts). Unlike
// the unit tests (which fake the SDK), this checks against pi's real
// built-in MCP extension that:
//   - the gate fires before bind even though no mcp__* tool is registered yet
//     (they are only registered once servers connect, at session_start);
//   - bindExtensions() really connects a server (spawns a child process and
//     registers its builtin:mcp tools);
//   - session_shutdown before dispose() really stops it.
//
// NOT part of `npm test`: depends on this machine's ~/.pi/agent/mcp.json
// having at least one enabled stdio server. Opt in explicitly:
//
//   PI_LIVE_E2E=1 npm run test:e2e
//
// Skips (not fails) when the precondition isn't met, naming it explicitly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildLoaderOptions } from "../../src/loader-config.ts";
import { needsExtensionBinding } from "../../src/extension-binding.ts";
import type { AgentConfig } from "../../src/agents.ts";

const live = process.env.PI_LIVE_E2E ? test : test.skip;
const MCP_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "mcp.json");

// Native MCP connects every enabled server at session_start, so any enabled
// stdio server ("command" set) spawns an observable child process.
function hasEnabledStdioMcpServer(): boolean {
  if (!fs.existsSync(MCP_CONFIG_PATH)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
    const servers = Object.values(config.mcpServers ?? {}) as Array<{ command?: string; enabled?: boolean }>;
    return servers.some((s) => typeof s.command === "string" && s.enabled !== false);
  } catch {
    return false;
  }
}

// Portable-enough child-process count: `ps -eo pid,ppid` exists on both
// macOS and Linux (unlike GNU-only `ps --ppid`).
function countChildProcesses(parentPid: number): number {
  const output = execSync("ps -eo pid,ppid").toString();
  let count = 0;
  for (const line of output.split("\n").slice(1)) {
    const [, ppid] = line.trim().split(/\s+/);
    if (Number(ppid) === parentPid) count++;
  }
  return count;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return predicate();
}

const agent: AgentConfig = {
  name: "integration-agent",
  description: "integration test agent",
  systemPromptMode: "append",
  inheritProjectContext: false,
  defaultReads: [],
  source: "user",
  filePath: "/tmp/integration-agent.md",
  systemPrompt: "",
};

live(
  "integration: the gate fires for built-in MCP before bind, bindExtensions() connects a real server (child process + builtin:mcp tools), and session_shutdown stops it",
  { timeout: 60_000 },
  async (t) => {
    if (!hasEnabledStdioMcpServer()) {
      t.skip(`no enabled stdio MCP server configured at ${MCP_CONFIG_PATH}`);
      return;
    }

    const resourceLoader = new DefaultResourceLoader(buildLoaderOptions(agent, process.cwd(), os.homedir()).options);
    await resourceLoader.reload();
    // No `tools` allowlist: every registered tool stays available, including
    // the built-in tool_search/codemode tools the gate keys on.
    const { session } = await createAgentSession({ resourceLoader, sessionManager: SessionManager.inMemory() });
    try {
      const toolsBeforeBind = session.getAllTools();
      assert.ok(
        !toolsBeforeBind.some((tool) => tool.sourceInfo.path === "builtin:mcp"),
        "expected no builtin:mcp tools before bind (they register once servers connect, at session_start)",
      );
      assert.equal(needsExtensionBinding(toolsBeforeBind), true, "expected the gate to fire before bind");

      const childrenBeforeBind = countChildProcesses(process.pid);

      await session.bindExtensions({ mode: "rpc" });
      const connected = await waitFor(
        () => session.getAllTools().some((tool) => tool.sourceInfo.path === "builtin:mcp"),
        30_000,
      );
      assert.ok(connected, "expected at least one builtin:mcp tool registered after bind");

      const childrenAfterBind = countChildProcesses(process.pid);
      assert.ok(
        childrenAfterBind > childrenBeforeBind,
        `expected bindExtensions to spawn at least one real child process ` +
          `(before: ${childrenBeforeBind}, after: ${childrenAfterBind})`,
      );

      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
      const stopped = await waitFor(() => countChildProcesses(process.pid) <= childrenBeforeBind, 5_000);
      assert.ok(
        stopped,
        `expected session_shutdown to stop the child process(es) bindExtensions spawned ` +
          `(before bind: ${childrenBeforeBind}, after shutdown: ${countChildProcesses(process.pid)})`,
      );
    } finally {
      session.dispose();
    }
  },
);
