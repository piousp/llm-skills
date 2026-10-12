import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionEntries,
  sumUsageTotals,
  usageCostBreakdown,
  computeCacheWaste,
  assistantTurnCount,
  firstUserMessage,
  buildSubagentSessionReport,
  type ReconcileFs,
} from "../../src/session-reconcile.ts";

// --- fixtures ----------------------------------------------------------------

// In-memory ReconcileFs: files is the complete on-disk view. listDir is
// derived from the path set (first path segment under the requested
// directory); a directory with no entries under it reads as missing, which
// ends the walk exactly like a real absent directory would.
function memFs(files: Record<string, string>): ReconcileFs {
  return {
    readTextFile: (p) => files[p],
    listDir: (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]);
      }
      return names.size > 0 ? [...names].sort() : undefined;
    },
  };
}

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

const HEADER = { type: "session", version: 1, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" };

function userMessage(content: string): unknown {
  return {
    type: "message",
    id: "u",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content },
  };
}

function assistantMessage(opts: {
  provider?: string;
  model?: string;
  responseModel?: string;
  timestamp?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  };
}): unknown {
  return {
    type: "message",
    id: "a",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      provider: opts.provider,
      model: opts.model,
      responseModel: opts.responseModel,
      timestamp: opts.timestamp,
      usage: opts.usage,
    },
  };
}

function toolResultMessage(usage: unknown): unknown {
  return { type: "message", id: "t", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", usage } };
}

// A persisted `subagent-result` completion message (the shape
// buildJobCompletionMessage writes into the parent session file).
function subagentResult(details: Record<string, unknown>): unknown {
  return {
    type: "custom_message",
    customType: "subagent-result",
    id: "r",
    timestamp: "2026-01-01T00:00:05.000Z",
    details,
  };
}

function aggregatedUsage(input: number, output: number, total: number): unknown {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function approx(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ~${expected}, got ${actual}`);
}

// --- parseSessionEntries -----------------------------------------------------

test("parseSessionEntries: skips blank and malformed lines, parses the rest", () => {
  const text = [
    JSON.stringify(HEADER),
    "not json at all",
    "",
    "   ",
    JSON.stringify({ type: "usage", usage: { input: 3 } }),
    "[1, 2, 3]", // arrays are not entries
  ].join("\n");
  const entries = parseSessionEntries(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, "session");
  assert.equal(entries[1].type, "usage");
});

// --- sumUsageTotals ----------------------------------------------------------

test("sumUsageTotals: assistant + toolResult + compaction/branch_summary + usage entries; user messages ignored", () => {
  const entries = parseSessionEntries(jsonl(
    HEADER,
    assistantMessage({ usage: { input: 10, output: 4, cacheRead: 100, cacheWrite: 2, cost: { total: 0.1 } } }),
    toolResultMessage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }),
    { type: "compaction", usage: { input: 5, cost: { total: 0.05 } } },
    { type: "branch_summary", usage: { input: 0, cost: { total: 0.002 } } },
    { type: "usage", usage: { input: 3, cost: { total: 0.0005 } } },
    // A user message carrying usage contributes nothing (pi's rule).
    { type: "message", message: { role: "user", usage: { input: 999, cost: { total: 9 } } } },
    // Entries without usage contribute nothing.
    userMessage("hello"),
  ));
  const totals = sumUsageTotals(entries);
  assert.equal(totals.input, 19);
  assert.equal(totals.output, 5);
  assert.equal(totals.cacheRead, 100);
  assert.equal(totals.cacheWrite, 2);
  approx(totals.cost, 0.1625, "cost");
});

// --- usageCostBreakdown ------------------------------------------------------

test("usageCostBreakdown: provider/responseModel ?? model for assistants, Tools/summaries for the rest, zero rows filtered, cost desc", () => {
  const entries = parseSessionEntries(jsonl(
    HEADER,
    assistantMessage({ provider: "anthropic", model: "claude-3", usage: { input: 10, output: 4, cacheRead: 100, cacheWrite: 2, cost: { total: 0.1 } } }),
    assistantMessage({ provider: "openai", model: "ignored", responseModel: "gptx", usage: { input: 200, cost: { total: 0.2 } } }),
    toolResultMessage({ input: 1, output: 1, cost: { total: 0.01 } }),
    { type: "compaction", usage: { input: 5, cost: { total: 0.05 } } },
    // Zero-cost, zero-token rows are filtered out.
    assistantMessage({ provider: "x", model: "y", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }),
    toolResultMessage({ input: 0, output: 0, cost: { total: 0 } }),
  ));
  const rows = usageCostBreakdown(entries);
  assert.deepEqual(rows.map((row) => row.key), ["openai/gptx", "anthropic/claude-3", "Tools/summaries"]);
  approx(rows[0].cost, 0.2, "openai cost");
  assert.equal(rows[0].tokens, 200);
  approx(rows[1].cost, 0.1, "anthropic cost");
  assert.equal(rows[1].tokens, 116); // 10 + 4 + 100 + 2
  approx(rows[2].cost, 0.06, "tools cost"); // 0.01 + 0.05
  assert.equal(rows[2].tokens, 7); // 1 + 1 + 5
});

// --- computeCacheWaste -------------------------------------------------------

test("computeCacheWaste: misses above the noise floor are counted, priced from the message's own cache-read cost", () => {
  const entries = parseSessionEntries(jsonl(
    HEADER,
    assistantMessage({ timestamp: 1_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 2000, cost: { input: 0.002, cacheWrite: 0.006, cacheRead: 0 } } }),
    assistantMessage({ timestamp: 2_000, usage: { input: 2000, output: 0, cacheRead: 500, cacheWrite: 0, cost: { input: 0.004, cacheRead: 0.0004 } } }),
  ));
  const waste = computeCacheWaste(entries);
  assert.equal(waste.missCount, 1);
  assert.equal(waste.missedTokens, 1500); // min(2000, 2500) - 500
  // paid: 0.004 / 2000 = 0.000002/token; read: 0.0004 / 500 = 0.0000008/token
  approx(waste.missedCost, 0.0018, "missedCost");
});

test("computeCacheWaste: a miss of exactly the noise floor (1024 tokens) counts nothing", () => {
  const entries = parseSessionEntries(jsonl(
    HEADER,
    assistantMessage({ timestamp: 1_000, usage: { input: 0, cacheRead: 0, cacheWrite: 2000, cost: { input: 0.002, cacheWrite: 0.006 } } }),
    assistantMessage({ timestamp: 2_000, usage: { input: 1024, cacheRead: 0, cacheWrite: 0, cost: { input: 0.01 } } }),
  ));
  assert.deepEqual(computeCacheWaste(entries), { missedTokens: 0, missedCost: 0, missCount: 0 });
});

test("computeCacheWaste: compaction and branch_summary reset the previous request", () => {
  for (const resetType of ["compaction", "branch_summary"] as const) {
    const entries = parseSessionEntries(jsonl(
      HEADER,
      assistantMessage({ timestamp: 1_000, usage: { input: 0, cacheRead: 0, cacheWrite: 2000, cost: { input: 0.002, cacheWrite: 0.006 } } }),
      { type: resetType, usage: { input: 10 } },
      assistantMessage({ timestamp: 2_000, usage: { input: 2000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.004 } } }),
    ));
    assert.deepEqual(computeCacheWaste(entries), { missedTokens: 0, missedCost: 0, missCount: 0 }, resetType);
  }
});

test("computeCacheWaste: zero-cache turns before any cache activity are not misses", () => {
  const entries = parseSessionEntries(jsonl(
    HEADER,
    assistantMessage({ timestamp: 1_000, usage: { input: 5000, cost: { total: 0.01 } } }),
    assistantMessage({ timestamp: 2_000, usage: { input: 5000, cost: { total: 0.01 } } }),
  ));
  assert.deepEqual(computeCacheWaste(entries), { missedTokens: 0, missedCost: 0, missCount: 0 });
});

test("computeCacheWaste: cacheRead === 0 after cache activity prices the read via the injected fallback", () => {
  const entries = parseSessionEntries(jsonl(
    HEADER,
    assistantMessage({ provider: "p", model: "m", timestamp: 1_000, usage: { input: 0, cacheRead: 0, cacheWrite: 2000, cost: { input: 0.002, cacheWrite: 0.006 } } }),
    assistantMessage({ provider: "p", model: "m", timestamp: 2_000, usage: { input: 2000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.004 } } }),
  ));

  const calls: Array<{ provider: string | undefined; model: string | undefined }> = [];
  const waste = computeCacheWaste(entries, (provider, model) => {
    calls.push({ provider, model });
    return 0.000001;
  });
  assert.equal(waste.missCount, 1);
  assert.equal(waste.missedTokens, 2000); // min(2000, 2000) - 0
  // paid: 0.004 / 2000 = 0.000002; read: fallback 0.000001
  approx(waste.missedCost, 0.002, "missedCost");
  assert.deepEqual(calls, [{ provider: "p", model: "m" }]);

  // A resolver returning undefined behaves like no catalog: read price 0,
  // so the full paid rate is the underestimate's miss cost.
  const wasteNoCatalog = computeCacheWaste(entries, () => undefined);
  approx(wasteNoCatalog.missedCost, 0.004, "missedCost without catalog");

  // The fallback is never consulted when the message itself reports a
  // cache-read price.
  const callsWhenReadReported: unknown[] = [];
  computeCacheWaste(
    parseSessionEntries(jsonl(
      HEADER,
      assistantMessage({ timestamp: 1_000, usage: { input: 0, cacheRead: 0, cacheWrite: 2000, cost: { input: 0.002, cacheWrite: 0.006 } } }),
      assistantMessage({ timestamp: 2_000, usage: { input: 2000, cacheRead: 500, cost: { input: 0.004, cacheRead: 0.0004 } } }),
    )),
    () => {
      callsWhenReadReported.push("called");
      return 999;
    },
  );
  assert.deepEqual(callsWhenReadReported, []);
});

test("computeCacheWaste: an empty session wastes nothing", () => {
  assert.deepEqual(computeCacheWaste([]), { missedTokens: 0, missedCost: 0, missCount: 0 });
});

// --- counts / task recovery --------------------------------------------------

test("assistantTurnCount: one assistant message is one turn; other roles do not count", () => {
  const entries = parseSessionEntries(jsonl(
    HEADER,
    userMessage("go"),
    assistantMessage({ usage: { input: 1 } }),
    toolResultMessage({}),
    assistantMessage({ usage: { input: 1 } }),
    userMessage("again"),
  ));
  assert.equal(assistantTurnCount(entries), 2);
});

test("firstUserMessage: string content and text blocks, ignoring later roles", () => {
  const stringContent = parseSessionEntries(jsonl(
    HEADER,
    toolResultMessage({}),
    userMessage("Investigate the flaky test"),
    assistantMessage({}),
  ));
  assert.equal(firstUserMessage(stringContent), "Investigate the flaky test");

  const blockContent = parseSessionEntries(jsonl(
    HEADER,
    { type: "message", message: { role: "user", content: [{ type: "toolCall", id: "t" }, { type: "text", text: "block text" }] } },
  ));
  assert.equal(firstUserMessage(blockContent), "block text");

  // A user message with no text is skipped, not returned as undefined early.
  const noText = parseSessionEntries(jsonl(
    HEADER,
    userMessage(""),
    userMessage("second"),
  ));
  assert.equal(firstUserMessage(noText), "second");
});

// --- buildSubagentSessionReport (the main fixture) ---------------------------

const BASE = "/fx/parent";
const SCOUT_CHILD = `${BASE}/call-scout/run-0/session.jsonl`;
const GRANDCHILD = `${BASE}/call-scout/run-0/session/call-grandchild/run-0/session.jsonl`;
const ORPHAN_CHILD = `${BASE}/orphan-dir/run-0/session.jsonl`;

// Parent: 2 disk-backed runs (completed + a grandchild parent), 1 errored,
// 1 message-only. Plus one child dir with NO completion message (orphan).
function mainFixtureFiles(): Record<string, string> {
  return {
    "/fx/parent.jsonl": jsonl(
      HEADER,
      userMessage("orchestrate the work"),
      subagentResult({
        jobId: "S1001", runId: "call-scout", status: "completed",
        task: { agent: "scout", task: "Find all fetch calls" },
        // Aggregate usage on the message: present but must NOT double-count
        // once the child's disk stats exist (disk-first).
        usage: aggregatedUsage(1000, 100, 0.05),
        isError: false,
      }),
      subagentResult({
        jobId: "S1002", runId: "call-broken", status: "errored",
        task: { agent: "scout", task: "broken" },
        isError: true,
        // errored messages carry neither run nor usage
      }),
      subagentResult({
        jobId: "S1003", runId: "call-msg-only", status: "completed",
        task: { agent: "planner", task: "plan the work" },
        usage: aggregatedUsage(120, 20, 0.012),
        isError: false,
      }),
    ),
    [SCOUT_CHILD]: jsonl(
      HEADER,
      userMessage("Find all fetch calls"),
      assistantMessage({
        provider: "anthropic", model: "claude-sonnet-4", timestamp: 1_700_000_000_000,
        usage: { input: 700, output: 80, cacheRead: 5000, cacheWrite: 200, cost: { input: 0.0021, output: 0.0004, cacheRead: 0.001, cacheWrite: 0.0006, total: 0.0041 } },
      }),
      toolResultMessage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0009 } }),
      { type: "compaction", usage: { input: 50, cost: { total: 0.00025 } } },
      assistantMessage({
        provider: "openai", model: "gpt-4o", responseModel: "gpt-4o-2024", timestamp: 1_700_000_100_000,
        usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } },
      }),
      // The grandchild's completion message lives in its immediate parent's
      // own session file (the child ran its own extension binding).
      subagentResult({
        jobId: "S1004", runId: "call-grandchild", status: "completed",
        task: { agent: "synthesizer", task: "Summarize findings" },
        isError: false,
      }),
    ),
    [GRANDCHILD]: jsonl(
      HEADER,
      userMessage("Summarize findings"),
      assistantMessage({ provider: "meta", model: "llama-3", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0002 } } }),
    ),
    [ORPHAN_CHILD]: jsonl(
      HEADER,
      userMessage("Investigate the flaky test"),
      assistantMessage({ provider: "anthropic", model: "claude-sonnet-4", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } } }),
    ),
  };
}

test("buildSubagentSessionReport: main fixture — attribution, disk-first usage, depths, counts", () => {
  const report = buildSubagentSessionReport("/fx/parent.jsonl", memFs(mainFixtureFiles()));

  // 5 runs: call-scout, call-grandchild, orphan dir, errored (dirless),
  // message-only (dirless).
  assert.equal(report.runs.length, 5);
  assert.deepEqual(report.counts, { completed: 3, failed: 0, cancelled: 0, errored: 1, running: 0, unknown: 1 });

  const scout = report.runs.find((run) => run.runId === "call-scout")!;
  assert.equal(scout.agent, "scout");
  assert.equal(scout.status, "completed");
  assert.equal(scout.task, "Find all fetch calls");
  assert.equal(scout.depth, 1);
  assert.equal(scout.orphaned, false);
  assert.equal(scout.sessionFile, SCOUT_CHILD);
  // Disk-first: the child's own totals, not the message's aggregate.
  assert.equal(scout.stats!.turns, 2);
  assert.equal(scout.stats!.totals.input, 1050); // 700 + 0 + 50 + 300
  assert.equal(scout.stats!.totals.output, 100);
  assert.equal(scout.stats!.totals.cacheRead, 5000);
  assert.equal(scout.stats!.totals.cacheWrite, 200);
  approx(scout.stats!.totals.cost, 0.00825, "scout disk cost");
  assert.equal(scout.messageUsage!.input, 1000); // carried, unused for totals

  const grandchild = report.runs.find((run) => run.runId === "call-grandchild")!;
  assert.equal(grandchild.agent, "synthesizer"); // attributed via the child's own jsonl
  assert.equal(grandchild.depth, 2);
  assert.equal(grandchild.status, "completed");
  assert.equal(grandchild.sessionFile, GRANDCHILD);
  approx(grandchild.stats!.totals.cost, 0.0002, "grandchild cost");

  const broken = report.runs.find((run) => run.runId === "call-broken")!;
  assert.equal(broken.status, "errored");
  assert.equal(broken.agent, "scout");
  assert.equal(broken.stats, undefined);
  assert.equal(broken.messageUsage, undefined); // zero usage, still counted

  const messageOnly = report.runs.find((run) => run.runId === "call-msg-only")!;
  assert.equal(messageOnly.agent, "planner");
  assert.equal(messageOnly.status, "completed");
  assert.equal(messageOnly.stats, undefined);
  assert.equal(messageOnly.sessionFile, undefined);
  approx(messageOnly.messageUsage!.cost.total, 0.012, "message-only usage");

  const orphan = report.runs.find((run) => run.runId === "orphan-dir")!;
  assert.equal(orphan.agent, "unknown");
  assert.equal(orphan.status, "unknown");
  assert.equal(orphan.task, "Investigate the flaky test"); // recovered from the child's own first user message
  assert.equal(orphan.orphaned, true);
  assert.equal(orphan.timestamp, undefined);
  assert.equal(orphan.depth, 1);
});

test("buildSubagentSessionReport: totals are the sum of effective usage (no parent+message double counting)", () => {
  const report = buildSubagentSessionReport("/fx/parent.jsonl", memFs(mainFixtureFiles()));
  assert.equal(report.totals.input, 1185); // 1050 + 10 + 5 + 120
  assert.equal(report.totals.output, 123); // 100 + 2 + 1 + 20
  assert.equal(report.totals.cacheRead, 5000);
  assert.equal(report.totals.cacheWrite, 200);
  approx(report.totals.cost, 0.02055, "report cost"); // 0.00825 + 0.0002 + 0.0001 + 0.012
});

test("buildSubagentSessionReport: breakdown merges disk rows and adds unattributed for message-only runs", () => {
  const report = buildSubagentSessionReport("/fx/parent.jsonl", memFs(mainFixtureFiles()));
  assert.deepEqual(report.breakdown.map((row) => row.key), [
    "unattributed", // 0.012 — message-only
    "anthropic/claude-sonnet-4", // scout 0.0041 + orphan 0.0001
    "openai/gpt-4o-2024",
    "Tools/summaries",
    "meta/llama-3",
  ]);
  approx(report.breakdown[0].cost, 0.012, "unattributed cost");
  assert.equal(report.breakdown[0].tokens, 140);
  approx(report.breakdown[1].cost, 0.0042, "anthropic cost");
  assert.equal(report.breakdown[1].tokens, 5986); // 5980 + 6
  approx(report.breakdown[2].cost, 0.003, "openai cost");
  approx(report.breakdown[3].cost, 0.00115, "tools cost");
  approx(report.breakdown[4].cost, 0.0002, "meta cost");
});

test("buildSubagentSessionReport: byAgent grouped by agent, cost desc; errored contributes no row", () => {
  const report = buildSubagentSessionReport("/fx/parent.jsonl", memFs(mainFixtureFiles()));
  assert.deepEqual(report.byAgent.map((row) => row.agent), ["planner", "scout", "synthesizer", "unknown"]);
  approx(report.byAgent[0].cost, 0.012, "planner cost");
  assert.equal(report.byAgent[0].runs, 1);
  assert.equal(report.byAgent[1].runs, 1);
  approx(report.byAgent[1].cost, 0.00825, "scout cost");
  assert.equal(report.byAgent[1].tokens, 6350);
  approx(report.byAgent[2].cost, 0.0002, "synthesizer cost");
  assert.equal(report.byAgent[2].runs, 1);
  assert.equal(report.byAgent[3].orphaned, true);
  assert.equal(report.byAgent[3].runs, 1);
});

test("buildSubagentSessionReport: an orphan whose raw runId is in activeRunIds (normalized) is running", () => {
  const report = buildSubagentSessionReport("/fx/parent.jsonl", memFs(mainFixtureFiles()), new Set(["orphan-dir"]));
  assert.equal(report.runs.find((run) => run.runId === "orphan-dir")!.status, "running");
  assert.equal(report.counts.running, 1);
  assert.equal(report.counts.unknown, 0);
});

test("buildSubagentSessionReport: activeRunIds are normalized through runIdDirName before comparison", () => {
  // Raw registry id "call broken" maps to the on-disk segment "call_broken".
  const files = {
    "/n/p.jsonl": jsonl(HEADER),
    "/n/p/call_broken/run-0/session.jsonl": jsonl(HEADER, userMessage("mid-flight task")),
  };
  const report = buildSubagentSessionReport("/n/p.jsonl", memFs(files), new Set(["call broken"]));
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].status, "running");
  assert.equal(report.runs[0].task, "mid-flight task");
});

test("buildSubagentSessionReport: the same child path listed twice is visited (and counted) once", () => {
  const files = {
    "/d/p.jsonl": jsonl(
      HEADER,
      subagentResult({ jobId: "S1", runId: "x", status: "completed", task: { agent: "scout", task: "t" } }),
    ),
    "/d/p/x/run-0/session.jsonl": jsonl(
      HEADER,
      userMessage("once only"),
      assistantMessage({ usage: { input: 5, cost: { total: 0.005 } } }),
    ),
  };
  const base = memFs(files);
  const fs: ReconcileFs = {
    readTextFile: base.readTextFile,
    listDir: (p) => (p === "/d/p" ? ["x", "x"] : base.listDir(p)), // duplicated listing
  };
  const report = buildSubagentSessionReport("/d/p.jsonl", fs);
  assert.equal(report.runs.length, 1);
  assert.equal(report.counts.completed, 1);
  assert.equal(report.totals.input, 5);
});

test("buildSubagentSessionReport: two runIds sanitizing to the same segment share one disk dir and count once", () => {
  // "a/b" and "a?b" both sanitize to the segment "a_b" — the same
  // dedupe that neutralizes the deep-<hash16> path-collapse collision.
  const files = {
    "/c/p.jsonl": jsonl(
      HEADER,
      subagentResult({ jobId: "S1", runId: "a/b", status: "completed", task: { agent: "scout", task: "first" } }),
      subagentResult({ jobId: "S2", runId: "a?b", status: "completed", task: { agent: "planner", task: "second" } }),
    ),
    "/c/p/a_b/run-0/session.jsonl": jsonl(
      HEADER,
      userMessage("shared"),
      assistantMessage({ usage: { input: 5, cost: { total: 0.005 } } }),
    ),
  };
  const report = buildSubagentSessionReport("/c/p.jsonl", memFs(files));
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].runId, "a/b"); // first message wins the attribution
  assert.equal(report.runs[0].agent, "scout");
  assert.equal(report.totals.cost, 0.005); // disk usage counted once, nothing unattributed
  assert.ok(!report.breakdown.some((row) => row.key === "unattributed"));
  assert.equal(report.byAgent.length, 1);
  assert.equal(report.byAgent[0].runs, 1);
});

test("buildSubagentSessionReport: a session with no children or messages yields an empty report", () => {
  const report = buildSubagentSessionReport("/none/missing.jsonl", memFs({}));
  assert.deepEqual(report.runs, []);
  assert.deepEqual(report.totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.deepEqual(report.breakdown, []);
  assert.deepEqual(report.byAgent, []);
  assert.deepEqual(report.counts, { completed: 0, failed: 0, cancelled: 0, errored: 0, running: 0, unknown: 0 });
});

// --- round-number regression -------------------------------------------------

// Dyadic cost values (0.375, 0.09375, 0.0625) so every float sum is exact and
// the assertions can pin totals/breakdown byte-for-byte. Hit rate:
// 3000 / (1000 + 3000 + 2000) = 46.2%.
test("round-number regression: exact totals, breakdown rows, and cache waste", () => {
  const files = {
    "/r/session.jsonl": jsonl(
      HEADER,
      subagentResult({
        jobId: "S1", runId: "call-r", status: "completed",
        task: { agent: "scout", task: "regression" },
        // Aggregate usage on the message — must not double-count.
        usage: aggregatedUsage(999999, 0, 9.99),
        isError: false,
      }),
    ),
    "/r/session/call-r/run-0/session.jsonl": jsonl(
      HEADER,
      assistantMessage({
        provider: "anthropic", model: "m", timestamp: 1_000,
        usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 2000, cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0.125, total: 0.375 } },
      }),
      assistantMessage({
        provider: "anthropic", model: "m", timestamp: 2_000,
        usage: { input: 500, output: 0, cacheRead: 3000, cacheWrite: 0, cost: { input: 0.0625, output: 0, cacheRead: 0.03125, cacheWrite: 0, total: 0.09375 } },
      }),
      toolResultMessage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0625 } }),
    ),
  };
  const report = buildSubagentSessionReport("/r/session.jsonl", memFs(files));

  assert.deepEqual(report.totals, { input: 1500, output: 0, cacheRead: 3000, cacheWrite: 2000, cost: 0.53125 });
  assert.deepEqual(report.breakdown, [
    // tokens = input + output + cacheRead + cacheWrite (pi's getUsageCostBreakdown
    // formula): 1000+2000 (msg 1) + 500+3000 (msg 2) = 6500.
    { key: "anthropic/m", cost: 0.46875, tokens: 6500 },
    { key: "Tools/summaries", cost: 0.0625, tokens: 0 },
  ]);
  assert.deepEqual(report.cacheWaste, { missedTokens: 0, missedCost: 0, missCount: 0 });
  assert.deepEqual(report.byAgent, [{ agent: "scout", runs: 1, tokens: 6500, cost: 0.53125, orphaned: false }]);
  assert.deepEqual(report.counts, { completed: 1, failed: 0, cancelled: 0, errored: 0, running: 0, unknown: 0 });
});
