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
import {
  overrideValueMatches,
  OVERRIDE_KEYS,
  OVERRIDE_TYPE_SPEC,
  type InvocationOverride,
} from "./overrides.ts";

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
  // Assistant toolCall blocks carry `id` (the host's toolCallId); toolResult
  // blocks and toolResult messages carry `toolCallId` naming the call they
  // answer. Only the fields the algorithms read are typed.
  content?: string | Array<{ type?: string; text?: string; id?: string; toolCallId?: string }>;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
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

// A persisted subagent launch acknowledgment (the tool result built by
// buildSubagentAckResult, read back from disk): a toolResult message named
// "subagent" whose details carry the job identity. Old-format acks (the
// pre-1.2.0 `details.runs` array shape) are tolerated and ignored: they have
// no runId, so no relaunch candidate can be enriched from them.
export interface SubagentAckDetails {
  jobId?: string;
  runId?: string;
  task?: { agent?: string; task?: string };
  // The launch call's REQUESTED invocation override, when the call carried
  // one. Extracted structurally only (per-key typeof guards below); the
  // semantic checks (model ref form, maxTurns range) stay at the relaunch-
  // time validateSubagentParams chokepoint.
  params?: InvocationOverride;
}

// Structural per-key extraction of details.params: expected types come
// from the shared type spec (src/overrides.ts's OVERRIDE_TYPE_SPEC —
// model/thinking: string, tools/skills: string[], maxTurns/timeoutMs:
// number). Ill-typed keys are dropped silently — this layer knows nothing
// about value ranges or name forms (layering precedent: validate.ts
// warn-and-drops structurally, the use-site chokepoints judge ranges). A
// params blob whose every key is ill-typed yields undefined: nothing was
// recorded that a relaunch could use, so the candidate falls into the
// legacy (no-params) arm exactly like a pre-params ack.
function ackParamsOf(record: Record<string, unknown>): InvocationOverride | undefined {
  const raw = record.params;
  if (raw === null || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const override: InvocationOverride = {};
  for (const key of OVERRIDE_KEYS) {
    if (overrideValueMatches(source[key], OVERRIDE_TYPE_SPEC[key])) {
      (override as Record<string, unknown>)[key] = source[key];
    }
  }
  if (Object.keys(override).length === 0) return undefined;
  return override;
}

export function subagentAckEntryOf(entry: SessionEntry): SubagentAckDetails | undefined {
  const message = messageOf(entry);
  if (!message || message.role !== "toolResult" || message.toolName !== "subagent") return undefined;
  const details = message.details;
  if (details === null || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  const task = record.task;
  const params = ackParamsOf(record);
  return {
    jobId: typeof record.jobId === "string" && record.jobId ? record.jobId : undefined,
    runId: typeof record.runId === "string" && record.runId ? record.runId : undefined,
    task:
      task !== null && typeof task === "object"
        ? {
            agent: typeof (task as Record<string, unknown>).agent === "string" ? (task as Record<string, unknown>).agent as string : undefined,
            task: typeof (task as Record<string, unknown>).task === "string" ? (task as Record<string, unknown>).task as string : undefined,
          }
        : undefined,
    ...(params !== undefined ? { params } : {}),
  };
}

/**
 * Assistant toolCalls with no matching toolResult anywhere in the entries:
 * the open tool-call pairs a session fork carries over when it is created
 * from an interrupted run's child file. Each returned pair needs one
 * synthetic toolResult appended to the forked copy (see src/task-runner.ts)
 * before the next model call, or the model sees a call it never got an
 * answer for. `toolName` comes from the same assistant block that yielded
 * the id — the only way to name the synthetic result honestly — with an
 * "unknown" fallback for a malformed opening block (a dangling pair must
 * still be closable). One pass; entries in file order, deduped by id.
 */
export interface DanglingToolCall {
  toolCallId: string;
  toolName: string;
}

export function danglingToolCalls(entries: readonly SessionEntry[]): DanglingToolCall[] {
  // First occurrence of an id names its tool: a duplicated toolCall block
  // would only re-encode the same open pair.
  const called = new Map<string, string>();
  const answered = new Set<string>();
  for (const entry of entries) {
    const message = messageOf(entry);
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && typeof block.id === "string" && block.id && !called.has(block.id)) {
          const name = (block as { name?: unknown }).name;
          called.set(block.id, typeof name === "string" && name ? name : "unknown");
        }
      }
    }
    if (typeof message.toolCallId === "string" && message.toolCallId) {
      answered.add(message.toolCallId);
    }
  }
  // A toolCall answered later in the file is not dangling (the answer arrives
  // in the toolResult message); a duplicate answer for a call never made is
  // ignored (nothing to close).
  return [...called.entries()]
    .filter(([id]) => !answered.has(id))
    .map(([toolCallId, toolName]) => ({ toolCallId, toolName }));
}

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

/**
 * The one usage-totals fold (session-reconcile's totals, the footer status
 * accumulator, the Main+Subagents combined total): adds one FLAT usage blob
 * — token buckets plus cost as a plain number — into `totals`. Fields that
 * are absent or non-numeric contribute zero; `undefined` usage contributes
 * nothing at all. Nested cost shapes ({ total }) are flattened by the
 * entry-level callers before reaching this fold.
 */
export function addUsageToTotals(
  totals: UsageTotals,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number } | undefined,
): void {
  totals.input += num(usage?.input);
  totals.output += num(usage?.output);
  totals.cacheRead += num(usage?.cacheRead);
  totals.cacheWrite += num(usage?.cacheWrite);
  totals.cost += num(usage?.cost);
}

/**
 * Sums every entry's usage into one total, mirroring pi's getSessionStats
 * accumulation (assistant + toolResult + compaction/branch_summary +
 * type:"usage"). Entries without usage contribute nothing. The nested→flat
 * adaptation (entry usage carries cost as a { total } object) happens here,
 * at the entry level.
 */
export function sumUsageTotals(entries: readonly SessionEntry[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    const usage = usageSourceOf(entry);
    if (usage) {
      addUsageToTotals(totals, {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: usage.cost?.total,
      });
    }
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
  /** Present only when the caller passed mainEntries: the parent session's own stats (pi's getSessionStats semantics). */
  main?: SessionUsageStats;
  /** main.totals + totals, field by field (no dedupe — the no-double-count note lives where the merge is built). */
  combined?: UsageTotals;
  /** Merge by key of main.breakdown + breakdown (main first), sorted by cost desc. */
  combinedBreakdown?: UsageBreakdownRow[];
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
  /** The parent session's own entries (in-memory, host-validated); a report without them has no main/combined fields. */
  mainEntries?: readonly SessionEntry[],
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

  const report = mergeReport(runs);
  // Without mainEntries the report keeps exactly its previous shape — the
  // derived fields below are purely additive, so existing consumers see no
  // change.
  if (mainEntries === undefined) return report;
  // MAIN is not a new algorithm: buildSessionUsageStats is the ported
  // pi getSessionStats already used for every child file — called once on
  // the parent's own entries this time.
  const main = buildSessionUsageStats(mainEntries);
  // No double counting, by construction: nothing injects subagent usage
  // into the parent's countable entries. The settled run's completion
  // message is a `custom_message` (usageSourceOf ignores it) and the launch
  // ack's toolResult carries no usage, so MAIN's totals and the subagent
  // totals never overlap; a dedupe guard here would be dead code (YAGNI).
  const combined = emptyUsageTotals();
  addUsageToTotals(combined, main.totals);
  addUsageToTotals(combined, report.totals);
  return {
    ...report,
    main,
    combined,
    combinedBreakdown: mergeBreakdownRows([main.breakdown, report.breakdown]),
  };
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

// Merges breakdown lists key by key: same key sums cost and tokens, unseen
// keys are copied; the result sorts by cost desc (pi's row ordering). Shared
// by the per-run merge and the main+subagent total merge.
function mergeBreakdownRows(lists: readonly (readonly UsageBreakdownRow[])[]): UsageBreakdownRow[] {
  const rowsByKey = new Map<string, UsageBreakdownRow>();
  for (const rows of lists) {
    for (const row of rows) {
      const existing = rowsByKey.get(row.key);
      if (existing) {
        existing.cost += row.cost;
        existing.tokens += row.tokens;
      } else {
        rowsByKey.set(row.key, { key: row.key, cost: row.cost, tokens: row.tokens });
      }
    }
  }
  return Array.from(rowsByKey.values()).sort((a, b) => b.cost - a.cost);
}

function mergeReport(runs: ReconciledRun[]): SubagentSessionReport {
  const totals = emptyUsageTotals();
  const breakdownRows: UsageBreakdownRow[] = [];
  let unattributedCost = 0;
  let unattributedTokens = 0;
  const cacheWaste: CacheWaste = { missedTokens: 0, missedCost: 0, missCount: 0 };
  const counts: Record<ReconciledRunStatus, number> = { completed: 0, failed: 0, cancelled: 0, errored: 0, running: 0, unknown: 0 };
  const byAgentRows = new Map<string, AgentUsageRow>();

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
      breakdownRows.push(...run.stats.breakdown);
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
    breakdownRows.push({ key: "unattributed", cost: unattributedCost, tokens: unattributedTokens });
  }

  const breakdown = mergeBreakdownRows([breakdownRows]);
  const byAgent = Array.from(byAgentRows.values()).sort((a, b) => b.cost - a.cost);
  return { runs, totals, breakdown, cacheWaste, byAgent, counts };
}

// --- relaunch candidates (retry/continue) ---

// One settled or orphaned run of THIS session that retry/continue could
// re-dispatch. `usage` is display-only; it feeds neither the command's
// behavior nor any accounting.
export interface SubagentRelaunchCandidate {
  /** Raw runId (the completion message's, or the ack's for enriched orphans); the dir segment for an un-enriched orphan. */
  readonly runId: string;
  /** The settled run's completion-message jobId, or the launch ack's jobId for orphans; absent when unrecoverable. */
  readonly jobId?: string;
  /** Resolved agent name, or "unknown" when nothing on disk names the agent. */
  readonly agent: string;
  /** The run's task: details.task.task, the ack's task, or the child's first user message. */
  readonly task?: string;
  /** Orphans display as "interrupted": crash, kill and disconnect are indistinguishable from disk. */
  readonly status: "failed" | "errored" | "cancelled" | "interrupted";
  /** The child's session.jsonl path — present means `continue` can branch from it. */
  readonly sessionFile?: string;
  /** Disk stats when the child file exists, else the completion message's aggregated usage. Display only. */
  readonly usage?: AggregatedUsage;
  /** The launch ack's recorded copy of the original call's invocation override, when one was recorded; relaunch wiring re-validates it. Absent (the key is omitted, never undefined-valued) for legacy acks. */
  readonly params?: InvocationOverride;
}

// A child run's display usage: its own disk stats converted to the
// AggregatedUsage shape when they exist on disk (disk-first, like
// effectiveTotals), else the parent's message usage, else nothing.
function displayUsageOf(run: ReconciledRun): AggregatedUsage | undefined {
  if (run.stats) {
    const totals = run.stats.totals;
    return {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: totals.cost,
      },
    };
  }
  return run.messageUsage;
}

/**
 * Depth-1 settled/orphaned runs of THIS session that `/subagents retry` and
 * `/subagents continue` can act on, reconstructed from disk.
 *
 * Internally one `buildSubagentSessionReport` walk carries the run statuses
 * (no second tree walk); a second read of the tiny parent file enriches
 * orphans with the launch acks (jobId, agent, task — the crash lost the
 * completion message, so `makeRun`'s orphan branch knows only "unknown").
 * The consumed-orphan bookkeeping lives in the command wiring; orphans here
 * are always fresh candidates.
 */
export function buildRelaunchCandidates(
  sessionFile: string,
  fs: ReconcileFs,
  activeRunIds?: ReadonlySet<string>,
): SubagentRelaunchCandidate[] {
  // Registry runIds are raw; normalize through runIdDirName exactly like
  // buildSubagentSessionReport does, so the "running" orphan (a live job in
  // THIS session) is excluded and never offered for relaunch.
  const report = buildSubagentSessionReport(sessionFile, fs, activeRunIds);

  const parentEntries = parseOrEmpty(fs.readTextFile(sessionFile));
  const ackBySegment = new Map<string, SubagentAckDetails>();
  const jobIdBySegment = new Map<string, string>();
  for (const entry of parentEntries) {
    const ack = subagentAckEntryOf(entry);
    if (ack?.runId) {
      const segment = runIdDirName(ack.runId);
      if (!ackBySegment.has(segment)) ackBySegment.set(segment, ack);
    }
    const result = subagentResultEntryOf(entry);
    const runId = result?.details?.runId;
    const jobId = result?.details?.jobId;
    if (result && typeof runId === "string" && runId && typeof jobId === "string" && jobId) {
      if (!jobIdBySegment.has(runIdDirName(runId))) jobIdBySegment.set(runIdDirName(runId), jobId);
    }
  }

  return report.runs
    .filter(
      (run) =>
        run.depth === 1 &&
        (run.status === "failed" || run.status === "errored" || run.status === "cancelled" ||
          // Orphaned with status "unknown": the dir is on disk, its completion
          // message never reached the parent, and no live job owns the runId
          // (the "running" orphan is a live job in this session, not a
          // candidate). Deeper descendants and completed runs never qualify.
          (run.orphaned && run.status === "unknown")),
    )
    .map((run): SubagentRelaunchCandidate => {
      if (!run.orphaned) {
        // The recorded params ride in by runId segment like everything else
        // read from the ack; relaunch-launched runs have no ack, so the
        // lookup can only miss, never mismatch.
        const params = ackBySegment.get(runIdDirName(run.runId))?.params;
        return {
          runId: run.runId,
          jobId: jobIdBySegment.get(runIdDirName(run.runId)),
          agent: run.agent,
          task: run.task,
          status: run.status as "failed" | "errored" | "cancelled",
          sessionFile: run.sessionFile,
          usage: displayUsageOf(run),
          // Key omitted, never undefined-valued: candidates are pinned by
          // full deepEqual, and a present-but-undefined key would break the
          // legacy (pre-params) fixtures.
          ...(params !== undefined ? { params } : {}),
        };
      }
      const segment = run.runId; // makeRun keys orphans by their dir segment.
      const ack = ackBySegment.get(runIdDirName(segment));
      return {
        runId: ack?.runId ?? segment,
        jobId: ack?.jobId,
        agent: ack?.task?.agent ?? "unknown",
        task: ack?.task?.task ?? run.task,
        status: "interrupted",
        sessionFile: run.sessionFile,
        usage: displayUsageOf(run),
        ...(ack?.params !== undefined ? { params: ack.params } : {}),
      };
    });
}
