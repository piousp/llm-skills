// Live integration test: creates a real AgentSession with the user's real,
// installed extensions (no -e/-ne, no `pi` subprocess, no prompt()/model
// call) and drives the exact bind -> shutdown sequence runAgentViaSdk uses
// (src/run.ts). This is the regression net for the fix itself: unlike the
// unit tests (which fake the SDK) and the `pi -p` e2e cases below (which
// exercise the mode gate but never actually call a real MCP tool), this is
// the only automated check that bindExtensions() really emits session_start
// and that a real extension (pi-mcp-adapter) really spawns a child process
// as a result — and that emitting session_shutdown before dispose() really
// stops it. Manual verification did this by hand in `tui` (three cases: a
// real Maven build, a real codegraph search, a real sbt build); this test
// automates the mechanism, not those specific tools.
//
// NOT part of `npm test`: depends on this machine's ~/.pi/agent/mcp.json
// having at least one configured server, and on pi-mcp-adapter being
// installed. Opt in explicitly:
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
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const live = process.env.PI_LIVE_E2E ? test : test.skip;
const MCP_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "mcp.json");

// Requires a server with lifecycle "eager"/"keep-alive", not just any
// configured server: pi-mcp-adapter's default ("lazy") only spawns a
// server's child process on its first actual tool call, not at
// session_start — so a lazy-only config can never make the child-process
// assertions below observe anything, regardless of whether bindExtensions
// ran at all. This precondition is deliberately stricter than "MCP is
// configured".
function hasEagerOrKeepAliveMcpServer(): boolean {
  if (!fs.existsSync(MCP_CONFIG_PATH)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
    const servers = Object.values(config.mcpServers ?? {}) as Array<{ lifecycle?: string }>;
    return servers.some((s) => s.lifecycle === "eager" || s.lifecycle === "keep-alive");
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

live(
  "integration: bindExtensions() initializes a real installed extension (spawns a child process), and session_shutdown really stops it",
  { timeout: 30_000 },
  async (t) => {
    if (!hasEagerOrKeepAliveMcpServer()) {
      t.skip(
        `no MCP server with lifecycle "eager"/"keep-alive" configured at ${MCP_CONFIG_PATH} — ` +
          `a "lazy" (the default) server only spawns on first tool call, not at session_start, ` +
          `so this test can't observe a bind-triggered process on this machine`,
      );
      return;
    }

    // No `tools` allowlist: extension tools (like `mcp`) are enabled by
    // default, and this test needs at least one of them present.
    const { session } = await createAgentSession({});
    try {
      const toolsBeforeBind = session.getAllTools();
      const packageToolBefore = toolsBeforeBind.find(
        (tool) => tool.sourceInfo.origin === "package" && tool.name !== "subagent",
      );
      assert.ok(
        packageToolBefore,
        "expected at least one installed-package tool (e.g. mcp) in the registry before bind " +
          "(bindExtensions only emits session_start; it doesn't change which tools are registered)",
      );

      const childrenBeforeBind = countChildProcesses(process.pid);

      await session.bindExtensions({ mode: "rpc" });
      // pi-mcp-adapter's session_start handler spawns MCP server child
      // processes asynchronously; give it a moment before checking.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const childrenAfterBind = countChildProcesses(process.pid);
      assert.ok(
        childrenAfterBind > childrenBeforeBind,
        `expected bindExtensions to spawn at least one real child process ` +
          `(before: ${childrenBeforeBind}, after: ${childrenAfterBind})`,
      );

      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const childrenAfterShutdown = countChildProcesses(process.pid);
      assert.equal(
        childrenAfterShutdown,
        childrenBeforeBind,
        `expected session_shutdown to stop the child process(es) bindExtensions spawned ` +
          `(before bind: ${childrenBeforeBind}, after shutdown: ${childrenAfterShutdown})`,
      );
    } finally {
      session.dispose();
    }
  },
);
