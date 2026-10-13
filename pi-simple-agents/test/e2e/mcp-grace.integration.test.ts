// Hermetic end-to-end test for the post-bind grace window (src/run.ts):
// runAgentViaSdk drives a REAL pi AgentSession — DefaultResourceLoader with
// pi's built-in codemode/tool-search/mcp extensions, no prompt()/model call —
// against a local zero-dependency fixture MCP server
// (test/fixtures/mcp-echo-server.mjs) whose connect is delayed.
//
// Always runs under `npm run test:e2e` (not gated by PI_LIVE_E2E) and reads
// nothing from ~/.pi or $HOME: the loader's home is a per-test tmp dir whose
// only content is this test's mcp.json.
//
// Cases covered:
//   (i)     direct exposure + exact requested name -> success; the tool is on
//           the roster at prompt time (it registered after bind, inside the
//           grace window).
//   (ii)+(iv) codemode (default) exposure + tools ["read",
//           "mcp__mcp-fixture__*"] with no tool_search/codemode crutch -> the
//           wildcard alone fires the bind, the tool registers after bind, and
//           the run does not false-fail "requested tool(s) never registered".
//   (iii)   a wildcard matching no server, short toolGraceMs -> loud error
//           naming the pattern, never prompts.
//   (v)     slow connect + abort during the grace -> "run was aborted"; the
//           fixture child process exits (symmetric session_shutdown).

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildLoaderOptions } from "../../src/loader-config.ts";
import { runAgentViaSdk, type AgentRunResult } from "../../src/run.ts";
import type { AgentConfig } from "../../src/agents.ts";

const SERVER_NAME = "mcp_fixture";
const FIXTURE_TOOL = `mcp__${SERVER_NAME}__echo`;
const FIXTURE_PATH = path.join(import.meta.dirname, "..", "fixtures", "mcp-echo-server.mjs");

// Copied from test/e2e/extension-binding.integration.test.ts (not exported
// there). Portable-enough child-process count: `ps -eo pid,ppid` exists on
// both macOS and Linux (unlike GNU-only `ps --ppid`).
function countChildProcesses(parentPid: number): number {
  const output = execSync("ps -eo pid,ppid").toString();
  let count = 0;
  for (const line of output.split("\n").slice(1)) {
    const [, ppid] = line.trim().split(/\s+/);
    if (Number(ppid) === parentPid) count++;
  }
  return count;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!predicate()) throw new Error(`${label} was not met within ${timeoutMs}ms`);
}

// Writes the per-test fixture home: <tmpRoot>/.pi/agent/mcp.json with one
// enabled stdio server pointing at the fixture. Returns the tmp root, which
// is the homeDir the loader must be given.
function writeFixtureHome(t: TestContext, delayMs: number, exposure?: string): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-mcp-grace-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const agentDir = path.join(tmpRoot, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const server: Record<string, unknown> = {
    command: "node",
    args: [FIXTURE_PATH],
    env: { FIXTURE_DELAY_MS: String(delayMs) },
    enabled: true,
  };
  if (exposure !== undefined) server.exposure = exposure;
  fs.writeFileSync(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, undefined, 2),
  );
  // Hermeticity: the MCP extension resolves its config through this env var
  // too; restore on test end so nothing leaks between tests.
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  return tmpRoot;
}

function makeAgent(tools: string[]): AgentConfig {
  return {
    name: "mcp-grace-agent",
    description: "e2e grace-window agent",
    tools,
    systemPromptMode: "append",
    inheritProjectContext: false,
    defaultReads: [],
    source: "user",
    filePath: "/tmp/mcp-grace-agent.md",
    systemPrompt: "",
  };
}

function buildLoader(homeRoot: string, agent: AgentConfig): DefaultResourceLoader {
  return new DefaultResourceLoader(buildLoaderOptions(agent, process.cwd(), homeRoot).options);
}

// Real-session seam: createSession runs the REAL createAgentSession (same
// loader a subagent gets), wrapped in a Proxy that overrides ONLY prompt
// (a no-op that snapshots the tool roster at prompt time — no model, no
// tokens) and getLastAssistantText ("ok"). Everything else — bind, tools,
// shutdown, dispose — is the session's real behavior.
function makeRealSessionOverride(resourceLoader: DefaultResourceLoader, rosterAtPrompt: string[]) {
  return async (opts: { tools?: string[]; excludeTools?: string[] }) => {
    const { session } = await createAgentSession({
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      tools: opts.tools,
      excludeTools: opts.excludeTools,
    });
    const wrapped = new Proxy(session, {
      get(target, prop) {
        if (prop === "prompt") {
          return async () => {
            rosterAtPrompt.push(...target.getAllTools().map((tool: { name: string }) => tool.name));
          };
        }
        if (prop === "getLastAssistantText") return () => "ok";
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { session: wrapped };
  };
}

async function runWithRealSession(
  t: TestContext,
  homeRoot: string,
  agent: AgentConfig,
  runOptions: { toolGraceMs?: number; signal?: AbortSignal } = {},
): Promise<{ result: AgentRunResult; rosterAtPrompt: string[] }> {
  const resourceLoader = buildLoader(homeRoot, agent);
  await resourceLoader.reload();
  const rosterAtPrompt: string[] = [];
  const result = await runAgentViaSdk(agent, "use the echo tool", {
    createSession: makeRealSessionOverride(resourceLoader, rosterAtPrompt) as never,
    modelRuntime: {} as never,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    toolGraceMs: runOptions.toolGraceMs,
    signal: runOptions.signal,
  });
  return { result, rosterAtPrompt };
}

test("mcp grace e2e: (i) direct exposure + exact requested name succeeds, tool present at prompt time", { timeout: 30_000 }, async (t) => {
  const homeRoot = writeFixtureHome(t, 300, "direct");
  const { result, rosterAtPrompt } = await runWithRealSession(t, homeRoot, makeAgent([FIXTURE_TOOL]));

  assert.equal(result.status, "success");
  assert.ok(
    rosterAtPrompt.includes(FIXTURE_TOOL),
    `expected ${FIXTURE_TOOL} on the roster at prompt time; got: ${rosterAtPrompt.join(", ")}`,
  );
});

test("mcp grace e2e: (ii)+(iv) default codemode exposure, wildcard alone fires bind, no false 'never registered'", { timeout: 30_000 }, async (t) => {
  const homeRoot = writeFixtureHome(t, 300);
  // No tool_search/codemode in the list: the wildcard must trigger the bind
  // by itself and the grace must cover the delayed registration.
  const { result, rosterAtPrompt } = await runWithRealSession(t, homeRoot, makeAgent(["read", `mcp__${SERVER_NAME}__*`]));

  assert.equal(result.status, "success");
  assert.ok(
    rosterAtPrompt.includes(FIXTURE_TOOL),
    `expected ${FIXTURE_TOOL} on the roster at prompt time; got: ${rosterAtPrompt.join(", ")}`,
  );
});

test("mcp grace e2e: (iii) a wildcard matching nothing fails loud after the grace, naming the pattern, no prompt", { timeout: 30_000 }, async (t) => {
  const homeRoot = writeFixtureHome(t, 300);
  const { result, rosterAtPrompt } = await runWithRealSession(t, homeRoot, makeAgent(["read", "mcp__no-such-server__*"]), {
    toolGraceMs: 200,
  });

  assert.equal(result.status, "error");
  assert.match((result as { status: "error"; error: string }).error, /mcp__no-such-server__\*/);
  assert.deepEqual(rosterAtPrompt, [], "the run must not prompt when the requested pattern matches nothing");
});

test("mcp grace e2e: (v) abort during the grace settles as 'run was aborted' and stops the fixture child", { timeout: 30_000 }, async (t) => {
  const homeRoot = writeFixtureHome(t, 5000);
  const childrenBefore = countChildProcesses(process.pid);
  const controller = new AbortController();

  const promise = runWithRealSession(t, homeRoot, makeAgent([FIXTURE_TOOL]), { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const { result, rosterAtPrompt } = await promise;

  assert.equal(result.status, "error");
  assert.match((result as { status: "error"; error: string }).error, /abort/i);
  assert.deepEqual(rosterAtPrompt, [], "an aborted run must not prompt");
  await waitFor(
    () => countChildProcesses(process.pid) <= childrenBefore,
    10_000,
    "the fixture child process must exit after the aborted run's session_shutdown",
  );
});
