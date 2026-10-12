// Pure reconciliation of a pi session's subagent usage from disk. The parent
// session file is parsed for `subagent-result` completion messages (see
// src/job-messages.ts), while the on-disk child session tree —
// <parent-session-file-without-ext>/<runId>/run-<N>/session.jsonl, the path
// convention childSessionDir (src/subagent-session.ts) persists under — is
// walked for each child run's own per-message stats. The per-message
// algorithms mirror pi's own /session command (dist/core/agent-session.js
// getSessionStats, dist/core/usage-totals.js getUsageCostBreakdown,
// dist/core/cache-stats.js computeCacheWaste), so this report's totals stay
// comparable with pi's output; the same structural-shape tolerance applies
// (unknown/extra fields pass through untouched).
//
// No filesystem access here: the caller injects a ReconcileFs seam, which
// keeps the whole module pure and unit-testable in memory.

import { basename, dirname, join, resolve } from "node:path";
import { runIdDirName } from "./subagent-session.ts";
import type { AggregatedUsage } from "./usage.ts";

// --- usage shapes -----------------------------------------------------------

// Session-total shape shared by the report and the per-run stats. `cost` is a
// plain number here (summed), unlike MessageUsage/AggregatedUsage where it is
// nested; every consumer of this module wants the summed form.
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

// One row of the per-model cost breakdown (pi's getUsageCostBreakdown rows).
export interface UsageBreakdownRow {
  key: string;
  cost: number;
  tokens: number;
}

// Cumulative cache waste: prompt tokens that should have been cache reads
// (they were in the previous turn's prompt) but were re-billed.
export interface CacheWaste {
  missedTokens: number;
  missedCost: number;
  missCount: number;
}

// Structural shape of a session entry's usage blob — only the fields the
// algorithms read are typed, everything else is tolerated and ignored.
export interface SessionUsageShape {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

// --- session entry shapes ---------------------------------------------------

// Structural view of an AgentMessage (pi's AgentMessage union, subset used
// here). `timestamp` is the message's own Unix-ms stamp (distinct from the
// entry's ISO timestamp).
export interface SessionMessageShape {
  role?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  timestamp?: number;
  content?: string | Array<{ type?: string; text?: string }>;
  usage?: SessionUsageShape;
}

export interface MessageEntry {
  type: "message";
  message?: SessionMessageShape;
}

export interface CompactionLikeEntry {
  type: "compaction" | "branch_summary";
  usage?: SessionUsageShape;
}

// Details of a persisted `subagent-result` completion message (the
// SubagentJobMessageDetails shape built by buildJobCompletionMessage in
// src/job-messages.ts, read back from disk).
export interface SubagentResultDetails {
  jobId?: string;
  runId?: string;
  status?: string;
  task?: { agent?: string; task?: string };
  // Full AgentRunResult on completed/cancelled/failed messages, absent on
  // errored ones. Not read by v1: per-run usage comes from the child session
  // file (disk-first) or details.usage.
  run?: { sessionFile?: string; [key: string]: unknown };
  usage?: AggregatedUsage;
  isError?: boolean;
}

export interface SubagentResultEntry {
  type: "custom_message";
  customType?: string;
  details?: SubagentResultDetails;
  timestamp?: string;
}

export interface SessionHeaderEntry {
  type: "session";
  version?: number;
  id?: string;
  cwd?: string;
}

// Permissive fallback: pi's loadEntriesFromFile tolerates unknown entry types
// and fields; so does this view.
export interface GenericSessionEntry {
  type: string;
  [key: string]: unknown;
}

export type SessionEntry =
  | SessionHeaderEntry
  | MessageEntry
  | CompactionLikeEntry
  | SubagentResultEntry
  | GenericSessionEntry;

// Injected FS seam: `undefined` means missing/unreadable (never thrown).
export interface ReconcileFs {
  readTextFile(path: string): string | undefined;
  listDir(path: string): string[] | undefined;
}

// Optional injected read-price resolver for cache-waste pricing (D8): when a
// message reports cacheRead === 0, pi falls back to the model catalog's read
// price. Without a catalog, this resolver (defaulting to 0) keeps the
// missedCost an underestimate — it can never overestimate the re-billed cost.
export type ReadPerTokenResolver = (provider: string | undefined, model: string | undefined) => number | undefined;

// --- parsing / per-message algorithms (ports of pi) ---

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function messageOf(entry: SessionEntry): SessionMessageShape | undefined {
  if (entry.type !== "message") return undefined;
  return (entry as MessageEntry).message;
}

/**
 * Parses a pi session .jsonl into entries with pi's loadEntriesFromFile
 * tolerance: blank and malformed lines are skipped, not fatal.
 */
export function parseSessionEntries(text: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as SessionEntry);
      }
    } catch {
      // Malformed line: skip it, same as pi.
    }
  }
  return entries;
}

// Which usage blob an entry contributes to session totals, mirroring pi's
// getSessionStats: assistant messages, toolResult messages carrying nested
// usage, compaction/branch_summary entries, and bare type:"usage" entries.
function usageSourceOf(entry: SessionEntry): SessionUsageShape | undefined {
  const message = messageOf(entry);
  if (message) {
    if (message.role === "assistant" || message.role === "toolResult") return message.usage;
    return undefined;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
    return (entry as CompactionLikeEntry).usage;
  }
  return undefined;
}

function addUsageToTotals(totals: UsageTotals, usage: SessionUsageShape): void {
  totals.input += num(usage.input);
  totals.output += num(usage.output);
  totals.cacheRead += num(usage.cacheRead);
  totals.cacheWrite += num(usage.cacheWrite);
  totals.cost += num(usage.cost?.total);
}

/**
 * Sums every entry's usage into one total, mirroring pi's getSessionStats
 * accumulation (assistant + toolResult + compaction/branch_summary +
 * type:"usage"). Entries without usage contribute nothing.
 */
export function sumUsageTotals(entries: readonly SessionEntry[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    const usage = usageSourceOf(entry);
    if (usage) addUsageToTotals(totals, usage);
  }
  return totals;
}

/**
 * Cost/token totals per provider/model, port of pi's getUsageCostBreakdown:
 * assistant usage is keyed by `provider/responseModel ?? model`; toolResult
 * messages and compaction/branch_summary entries group under
 * "Tools/summaries". Rows with nothing to show are filtered out and the rest
 * sort by cost, descending.
 */
export function usageCostBreakdown(entries: readonly SessionEntry[]): UsageBreakdownRow[] {
  const rows = new Map<string, UsageBreakdownRow>();
  for (const entry of entries) {
    let key: string | undefined;
    let usage: SessionUsageShape | undefined;
    const message = messageOf(entry);
    if (message) {
      if (message.role === "assistant") {
        key = `${message.provider}/${message.responseModel ?? message.model}`;
        usage = message.usage;
      } else if (message.role === "toolResult" && message.usage) {
        key = "Tools/summaries";
        usage = message.usage;
      }
    } else if (
      (entry.type === "compaction" || entry.type === "branch_summary") &&
      (entry as CompactionLikeEntry).usage
    ) {
      key = "Tools/summaries";
      usage = (entry as CompactionLikeEntry).usage;
    }
    if (!key || !usage) continue;
    let row = rows.get(key);
    if (!row) {
      row = { key, cost: 0, tokens: 0 };
      rows.set(key, row);
    }
    row.cost += num(usage.cost?.total);
    row.tokens += num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
  }
  return Array.from(rows.values())
    .filter((row) => row.cost > 0 || row.tokens > 0)
    .sort((a, b) => b.cost - a.cost);
}

// Port of pi's cache-stats.js noise floor: per-turn misses at or below this
// are cache breakpoint granularity noise.
const NOISE_FLOOR_TOKENS = 1024;

interface PreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
}

interface MissCandidate {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  promptTokens: number;
  cost: SessionUsageShape["cost"];
  provider: string | undefined;
  model: string | undefined;
  timestamp: number;
}

function detectMiss(
  prev: PreviousRequest | undefined,
  candidate: MissCandidate,
  readPerTokenFallback: ReadPerTokenResolver | undefined,
): { missedTokens: number; missedCost: number } | undefined {
  // A zero-cache turn only counts when cache activity was reported before:
  // on cache-read-only providers that is a total miss, while on providers
  // that never report caching it means nothing.
  if (
    !prev ||
    candidate.promptTokens <= 0 ||
    (candidate.cacheRead + candidate.cacheWrite === 0 && !prev.reportedCache)
  ) {
    return undefined;
  }
  const missedTokens = Math.min(prev.promptTokens, candidate.promptTokens) - candidate.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;
  // Extra cost = missed tokens billed at the paid rate (input/cacheWrite,
  // incl. write premium) instead of the cache-read rate. Missed tokens can
  // only land in the input or cacheWrite buckets, so the paid rate comes
  // straight from this message's own cost breakdown.
  const paidTokens = candidate.input + candidate.cacheWrite;
  const paidPerToken = paidTokens > 0 ? (num(candidate.cost?.input) + num(candidate.cost?.cacheWrite)) / paidTokens : 0;
  const readPerToken =
    candidate.cacheRead > 0
      ? num(candidate.cost?.cacheRead) / candidate.cacheRead
      : (readPerTokenFallback?.(candidate.provider, candidate.model) ?? 0);
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
  };
}

function asPreviousRequest(candidate: MissCandidate, reportedCache: boolean): PreviousRequest | undefined {
  if (candidate.promptTokens <= 0) return undefined;
  return {
    promptTokens: candidate.promptTokens,
    modelKey: `${candidate.provider}/${candidate.model}`,
    timestamp: candidate.timestamp,
    reportedCache,
  };
}

/**
 * Cumulative cache waste across a session, port of pi's computeCacheWaste
 * (detectMiss/scan). Misses below the noise floor and turns without prior
 * cache activity count nothing; compaction and branch_summary entries reset
 * the previous-request state (the next turn's prompt is new content, not
 * re-billed). Without a cache-read price on the message itself, the
 * injected fallback (default 0) prices the read side — an underestimate,
 * never an overestimate.
 */
export function computeCacheWaste(
  entries: readonly SessionEntry[],
  readPerTokenFallback?: ReadPerTokenResolver,
): CacheWaste {
  let prev: PreviousRequest | undefined;
  const totals: CacheWaste = { missedTokens: 0, missedCost: 0, missCount: 0 };
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      // The context legitimately changed; the next turn's prompt is new
      // content, not re-billed. Model switches are NOT exempt: they re-bill
      // the full prompt and should be counted.
      prev = undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = messageOf(entry);
    if (!message || message.role !== "assistant" || !message.usage) continue;
    const candidate: MissCandidate = {
      input: num(message.usage.input),
      cacheRead: num(message.usage.cacheRead),
      cacheWrite: num(message.usage.cacheWrite),
      promptTokens:
        num(message.usage.input) + num(message.usage.cacheRead) + num(message.usage.cacheWrite),
      cost: message.usage.cost,
      provider: message.provider,
      model: message.model,
      timestamp: num(message.timestamp),
    };
    const miss = detectMiss(prev, candidate, readPerTokenFallback);
    if (miss) {
      totals.missedTokens += miss.missedTokens;
      totals.missedCost += miss.missedCost;
      totals.missCount += 1;
    }
    prev = asPreviousRequest(candidate, (prev?.reportedCache ?? false) || candidate.cacheRead + candidate.cacheWrite > 0) ?? prev;
  }
  return totals;
}

/** One assistant message = one turn (pi's turns definition). */
export function assistantTurnCount(entries: readonly SessionEntry[]): number {
  let turns = 0;
  for (const entry of entries) {
    if (messageOf(entry)?.role === "assistant") turns += 1;
  }
  return turns;
}

function countMessages(entries: readonly SessionEntry[], role: string): number {
  let count = 0;
  for (const entry of entries) {
    if (messageOf(entry)?.role === role) count += 1;
  }
  return count;
}

// Text of a message's content: plain string as-is, or the text blocks of a
// content array joined with newlines (pi's contentText shape).
function messageTextOf(content: SessionMessageShape["content"]): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

/** The first user message's text, used to recover an orphaned run's task. */
export function firstUserMessage(entries: readonly SessionEntry[]): string | undefined {
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message?.role !== "user") continue;
    const text = messageTextOf(message.content);
    if (text) return text;
  }
  return undefined;
}

// --- report assembly ---

export interface SessionUsageStats {
  turns: number;
  userMessages: number;
  toolResults: number;
  totals: UsageTotals;
  breakdown: UsageBreakdownRow[];
  cacheWaste: CacheWaste;
}

/**
 * Per-run stats from one child session file: the pi /session numbers for
 * that file alone (per-model breakdown, cache waste, turn counts).
 */
export function buildSessionUsageStats(
  entries: readonly SessionEntry[],
  readPerTokenFallback?: ReadPerTokenResolver,
): SessionUsageStats {
  return {
    turns: assistantTurnCount(entries),
    userMessages: countMessages(entries, "user"),
    toolResults: countMessages(entries, "toolResult"),
    totals: sumUsageTotals(entries),
    breakdown: usageCostBreakdown(entries),
    cacheWaste: computeCacheWaste(entries, readPerTokenFallback),
  };
}

export type ReconciledRunStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "errored"
  | "running"
  | "unknown";

export const RECONCILED_RUN_STATUSES: readonly ReconciledRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "errored",
  "running",
  "unknown",
];

export interface ReconciledRun {
  runId: string;
  /** 1 = direct child of the reconciled root session, 2 = grandchild, ... */
  depth: number;
  agent: string;
  status: ReconciledRunStatus;
  task?: string;
  /** ISO timestamp of the parent's completion message (absent on orphans). */
  timestamp?: string;
  /** Per-message stats from the child's own session.jsonl (disk-first). */
  stats?: SessionUsageStats;
  /** Aggregated usage carried by the parent's completion message (fallback). */
  messageUsage?: AggregatedUsage;
  /** The child's session.jsonl path, when it exists on disk. */
  sessionFile?: string;
  /** True when no completion message matched this child directory. */
  orphaned: boolean;
}

export interface AgentUsageRow {
  agent: string;
  runs: number;
  tokens: number;
  cost: number;
  /** True when every run behind this row was orphaned (no completion message). */
  orphaned: boolean;
}

export interface SubagentSessionReport {
  runs: ReconciledRun[];
  /** Sum of each run's effective usage — no double counting. */
  totals: UsageTotals;
  /** Merged per-model breakdown of the disk stats, plus "unattributed" for message-only runs. */
  breakdown: UsageBreakdownRow[];
  cacheWaste: CacheWaste;
  byAgent: AgentUsageRow[];
  counts: Record<ReconciledRunStatus, number>;
}

// Guard against pathological trees (or a runaway convention match): the walk
// stops after this many distinct child directories, whatever the depth.
const MAX_CHILDREN_VISITED = 1000;

const RUN_DIR_SEGMENT_PATTERN = /^run-\d+$/;

function normalizeStatus(raw: unknown): ReconciledRunStatus {
  return raw === "completed" || raw === "failed" || raw === "cancelled" || raw === "errored"
    ? raw
    : "unknown";
}

function subagentResultEntryOf(entry: SessionEntry): SubagentResultEntry | undefined {
  if (entry.type !== "custom_message" || (entry as SubagentResultEntry).customType !== SUBAGENT_RESULT_MESSAGE_TYPE) {
    return undefined;
  }
  return entry as SubagentResultEntry;
}

// The completion message type persisted by buildJobCompletionMessage
// (src/job-messages.ts) — duplicated as a literal because job-messages
// imports from this module's siblings, not the other way around.
const SUBAGENT_RESULT_MESSAGE_TYPE = "subagent-result";

function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

// A run's effective usage: the child file's own totals when it exists on
// disk (disk-first), else the parent message's aggregated usage, else
// nothing (errored runs and runs whose child file vanished).
function effectiveTotals(run: ReconciledRun): UsageTotals | undefined {
  if (run.stats) return run.stats.totals;
  const usage = run.messageUsage;
  if (!usage) return undefined;
  return {
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    cost: num(usage.cost?.total),
  };
}

/**
 * Reconciles a session's subagent usage from disk into one report.
 *
 * Walks the parent session file for `subagent-result` completion messages
 * (ALL entries, no branch filtering — same semantics as pi's /session), then
 * the child session tree by the childSessionDir path convention. Each child
 * directory is counted exactly once (dedupe by resolved path, which also
 * neutralizes the deep-<hash16> path-collapse collision case); the whole
 * descendant tree is included, with grandchildren attributed by the
 * `subagent-result` messages in their immediate parent's own .jsonl.
 *
 * Attribution per child directory: the dir segment matches
 * runIdDirName(details.runId) of a completion message in the IMMEDIATE
 * parent file → agent/status/task/timestamp come from that message. No
 * match → orphan: agent "unknown", task recovered from the child's first
 * user message, status "running" when the dir's runId is in activeRunIds
 * (the in-memory registry is used ONLY to label state, never as a usage
 * source), else "unknown".
 *
 * Effective usage per run is disk-first: the child session.jsonl's own
 * stats when readable, else the completion message's details.usage
 * (contributing to the "unattributed" breakdown bucket). Errored runs
 * contribute nothing but still count toward the run totals.
 */
export function buildSubagentSessionReport(
  rootSessionFile: string,
  fs: ReconcileFs,
  activeRunIds?: ReadonlySet<string>,
  readPerTokenFallback?: ReadPerTokenResolver,
): SubagentSessionReport {
  // Registry runIds are raw; the comparison happens against directory
  // segments, so normalize both sides through the same transformation
  // childSessionDir applies.
  const activeSegments = new Set(Array.from(activeRunIds ?? [], (id) => runIdDirName(id)));
  const visited = new Set<string>([resolve(rootSessionFile)]);
  const budget = { remaining: MAX_CHILDREN_VISITED };
  const runs: ReconciledRun[] = [];

  const reconcile = (sessionFile: string, depth: number): void => {
    const parentEntries = parseOrEmpty(fs.readTextFile(sessionFile));
    // Completion messages of THIS file, keyed by the directory segment their
    // runId maps to. Duplicated segments (sanitization collisions, including
    // the deep-<hash16> collapse case) collapse to the first message — the
    // one child directory on disk is shared, so it must be counted once.
    const resultBySegment = new Map<string, SubagentResultEntry>();
    for (const entry of parentEntries) {
      const resultEntry = subagentResultEntryOf(entry);
      const runId = resultEntry?.details?.runId;
      if (!resultEntry || typeof runId !== "string" || !runId) continue;
      const segment = runIdDirName(runId);
      if (!resultBySegment.has(segment)) resultBySegment.set(segment, resultEntry);
    }

    const baseDir = join(dirname(sessionFile), basename(sessionFile, ".jsonl"));
    // Segments this level's walk actually visited — a message whose segment
    // matches a directory on disk is handled there, everything else below is
    // a completion message with no child directory to read.
    const matchedSegments = new Set<string>();
    const childNames = fs.listDir(baseDir);
    if (childNames) {
      for (const childName of [...childNames].sort()) {
        const runIndices = fs.listDir(join(baseDir, childName));
        if (!runIndices) continue;
        for (const runIndex of [...runIndices].sort()) {
          if (!RUN_DIR_SEGMENT_PATTERN.test(runIndex)) continue;
          if (budget.remaining <= 0) return;
          budget.remaining -= 1;
          const childFile = join(baseDir, childName, runIndex, "session.jsonl");
          const resolvedChild = resolve(childFile);
          if (visited.has(resolvedChild)) continue;
          visited.add(resolvedChild);
          matchedSegments.add(childName);
          runs.push(
            makeRun(childFile, childName, depth, resultBySegment.get(childName), activeSegments, readPerTokenFallback, fs),
          );
          reconcile(childFile, depth + 1);
        }
      }
    }
    // Completion messages whose child directory never appeared on disk:
    // message-only runs fall back to details.usage (D6, rendered as the
    // "unattributed" bucket) and errored messages contribute zero usage but
    // still count toward the run totals (D4).
    for (const [segment, resultEntry] of resultBySegment) {
      if (matchedSegments.has(segment)) continue;
      runs.push(dirlessRun(resultEntry, segment, depth));
    }
  };

  reconcile(rootSessionFile, 1);

  return mergeReport(runs);
}

function parseOrEmpty(text: string | undefined): SessionEntry[] {
  return text !== undefined ? parseSessionEntries(text) : [];
}

// A completion message whose child directory does not exist on disk at its
// own level: no per-message stats are possible, so the run rides on the
// message's own aggregated usage (which lands in the "unattributed" cost
// bucket) — or on nothing at all for errored messages, whose details carry
// neither run nor usage. Such a run is never an orphan: the completion
// message did reach the parent's session file.
function dirlessRun(entry: SubagentResultEntry, segment: string, depth: number): ReconciledRun {
  const details = entry.details ?? {};
  return {
    runId: typeof details.runId === "string" && details.runId ? details.runId : segment,
    depth,
    agent: details.task?.agent ?? "unknown",
    status: normalizeStatus(details.status),
    task: details.task?.task,
    timestamp: entry.timestamp,
    stats: undefined,
    messageUsage: details.usage,
    sessionFile: undefined,
    orphaned: false,
  };
}

function makeRun(
  childFile: string,
  segment: string,
  depth: number,
  matched: SubagentResultEntry | undefined,
  activeSegments: ReadonlySet<string>,
  readPerTokenFallback: ReadPerTokenResolver | undefined,
  fs: ReconcileFs,
): ReconciledRun {
  const childEntries = parseOrEmpty(fs.readTextFile(childFile));
  const stats = childEntries.length > 0 ? buildSessionUsageStats(childEntries, readPerTokenFallback) : undefined;

  if (matched) {
    const details = matched.details ?? {};
    return {
      runId: typeof details.runId === "string" && details.runId ? details.runId : segment,
      depth,
      agent: details.task?.agent ?? "unknown",
      status: normalizeStatus(details.status),
      task: details.task?.task,
      timestamp: matched.timestamp,
      stats,
      messageUsage: details.usage,
      sessionFile: stats ? childFile : undefined,
      orphaned: false,
    };
  }
  // Orphan: the child dir is on disk but its completion message never made
  // it into the parent (the process died mid-run).
  return {
    runId: segment,
    depth,
    agent: "unknown",
    status: activeSegments.has(segment) ? "running" : "unknown",
    task: childEntries.length > 0 ? firstUserMessage(childEntries) : undefined,
    stats,
    sessionFile: stats ? childFile : undefined,
    orphaned: true,
  };
}

function mergeReport(runs: ReconciledRun[]): SubagentSessionReport {
  const totals = emptyUsageTotals();
  const rowsByKey = new Map<string, UsageBreakdownRow>();
  let unattributedCost = 0;
  let unattributedTokens = 0;
  const cacheWaste: CacheWaste = { missedTokens: 0, missedCost: 0, missCount: 0 };
  const counts: Record<ReconciledRunStatus, number> = { completed: 0, failed: 0, cancelled: 0, errored: 0, running: 0, unknown: 0 };
  const byAgentRows = new Map<string, AgentUsageRow>();

  const mergeBreakdownRow = (row: UsageBreakdownRow): void => {
    const existing = rowsByKey.get(row.key);
    if (existing) {
      existing.cost += row.cost;
      existing.tokens += row.tokens;
    } else {
      rowsByKey.set(row.key, { key: row.key, cost: row.cost, tokens: row.tokens });
    }
  };

  for (const run of runs) {
    counts[run.status] += 1;
    const effective = effectiveTotals(run);
    if (effective) {
      totals.input += effective.input;
      totals.output += effective.output;
      totals.cacheRead += effective.cacheRead;
      totals.cacheWrite += effective.cacheWrite;
      totals.cost += effective.cost;
    }
    if (run.stats) {
      for (const row of run.stats.breakdown) mergeBreakdownRow(row);
      cacheWaste.missedTokens += run.stats.cacheWaste.missedTokens;
      cacheWaste.missedCost += run.stats.cacheWaste.missedCost;
      cacheWaste.missCount += run.stats.cacheWaste.missCount;
    } else if (effective) {
      // Message-only run: no per-model attribution exists on disk.
      unattributedCost += effective.cost;
      unattributedTokens += effective.input + effective.output + effective.cacheRead + effective.cacheWrite;
    }

    // D4: errored runs count toward the run totals with zero usage, but
    // contribute no by-agent row (there is no run result to attribute).
    if (run.status === "errored") continue;
    let agentRow = byAgentRows.get(run.agent);
    if (!agentRow) {
      agentRow = { agent: run.agent, runs: 0, tokens: 0, cost: 0, orphaned: run.orphaned };
      byAgentRows.set(run.agent, agentRow);
    } else {
      agentRow.orphaned = agentRow.orphaned && run.orphaned;
    }
    agentRow.runs += 1;
    if (effective) {
      agentRow.tokens += effective.input + effective.output + effective.cacheRead + effective.cacheWrite;
      agentRow.cost += effective.cost;
    }
  }

  // Same visibility rule as pi's breakdown rows: a bucket with nothing to
  // show is omitted, so "unattributed" appears only when message-only runs
  // actually carry usage.
  if (unattributedCost > 0 || unattributedTokens > 0) {
    mergeBreakdownRow({ key: "unattributed", cost: unattributedCost, tokens: unattributedTokens });
  }

  const breakdown = Array.from(rowsByKey.values()).sort((a, b) => b.cost - a.cost);
  const byAgent = Array.from(byAgentRows.values()).sort((a, b) => b.cost - a.cost);
  return { runs, totals, breakdown, cacheWaste, byAgent, counts };
}
