import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { NotifyType, ObserveSurface, SkillImproveUi } from "../command-skill-improve.ts";
import { readCaseBank } from "../case-bank.ts";
import type { CaseCheck } from "../checks.ts";
import { readObserveConfigOf, readSriConfigOf } from "../config.ts";
import { eligibilityOfSkill, isEligible } from "../eligibility.ts";
import { SriFailClosedError, SriWriterError } from "../errors.ts";
import { modelIdentity, textOf } from "../evidence.ts";
import { acceptCandidate, type AcceptDeps, type AcceptOutcome, type AcceptRejection } from "../gate/acceptance.ts";
import { gateDirectionalCandidate, type DirectionalGateResult } from "../gate/directional-flow.ts";
import { resolveStagedCandidate, verifiedStagedLesson, type GateFlowResult, type GateRequest } from "../gate/flow.ts";
import { probationRecordOf } from "../gate/probation.ts";
import { planDesign } from "../gate/scorer.ts";
import { sha256Digest, sha256Hex } from "../hash.ts";
import {
  proposeSkill,
  type ImproveFlowContext,
  type ImproveFlowSession,
  type ImproveRequest,
} from "../improve-flow.ts";
import { parseLesson } from "../lesson-frontmatter.ts";
import { readLedger } from "../ledger.ts";
import { createModelCall, wireDirectionalGate, type ModelCallRegistry } from "../model-call.ts";
import { CASE_BANK_FILE, LESSONS_DIR, SKILL_FILE } from "../names.ts";
import { splitSkillBlock } from "../skill-block.ts";
import { findSkill, listSkills } from "../skills-inventory.ts";
import type { Result, SkillRef, SriConfig } from "../types.ts";
import { currentTime, cutCodePoints, isDirectory, quote, toErrorMessage } from "../values.ts";
import { banksDir, labelingDir, stagingDir, writeBase } from "../write-base.ts";
import { createExclusiveFile, ensurePrivateDir, writePrivateFile } from "../writer.ts";
import { createBankGenerator } from "./auto-bank.ts";
import { discardSkillArtifacts } from "./forget.ts";
import { bankPathOf, resolveBank, selectBankEpisodes } from "./banks.ts";
import {
  latestBy,
  runObserveCycle,
  type BankSelection,
  type BankSelectionResult,
  type CostEstimate,
  type CycleDeps,
  type CycleInput,
  type CycleReport,
  type CycleVerdict,
  type GateOutcomeView,
  type ProposalDraft,
} from "./cycle.ts";
import { cursorEntryOf as entryOfCursor, planScan, readCursor, writeCursor } from "./cursor.ts";
import { segmentEpisodes, userAuthoredTurns } from "./episodes.ts";
import { createEpisodeJudge, estimateJudgeCost, providerGate, type JudgeInput, type JudgeTurn } from "./judge.ts";
import { classifyGateResult, type GateClassification } from "./outcome.ts";
import { assignPattern, patternViews, proposablePatterns, type KnownPattern } from "./patterns.ts";
import { prefilterEpisode } from "./prefilter.ts";
import { offerAcceptance, offerProposal, type BankCaseView, type ProposalView } from "./prompts.ts";
import { redactSecrets } from "./redact.ts";
import { dispatchReview, reviewProposal, type ReviewApi, type ReviewDeps, type ReviewResult } from "./review.ts";
import { isExcludedCwd, isTopLevelSessionFile, listTopLevelSessionFiles, readSessionFile, sessionsRootOf } from "./session-file.ts";
import { appendObserveEvents, foldObserveState, readObserveLog } from "./store.ts";
import { withScanLock } from "./lock.ts";
import {
  MAX_SUMMARY_CHARS,
  type Episode,
  type EpisodeEvent,
  type JudgeFinding,
  type ObservationEvent,
  type ObserveConfig,
  type ObserveState,
  type PatternView,
  type ProposalEvent,
} from "./types.ts";

// The live wiring of the observer: it binds the real collaborators to the contracts of src/observe/cycle.ts and src/observe/review.ts,
// and decides when a cycle may start. The sequencing is the cycle's and the rules are the modules'; what this file owns is which
// real function answers each dependency, and the gate that keeps the cycle out of every session that is not a top-level
// interactive one.

// ---------------------------------------------------------------------------------------------
// What the wiring reads from pi
// ---------------------------------------------------------------------------------------------

export interface ObserveUi {
  select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  notify(message: string, type?: NotifyType): void;
}

// pi's ModelRegistry: `complete` is the call every model request goes through, `find` resolves a pinned judge model. `find` is
// optional in the type so the registry a command context declares satisfies it; pi's real one always has it.
export type ObserveModelRegistry = ModelCallRegistry & { find?(provider: string, modelId: string): Model<Api> | undefined };

export interface ObserveSession extends ImproveFlowSession {
  getSessionDir(): string;
  getSessionFile(): string | undefined;
}

// The context a cycle runs with: what the loop reads (ImproveFlowContext) plus the dialogs, the idle check and the session
// files. pi's own ExtensionContext satisfies it in the TUI.
export interface ObserveContext extends ImproveFlowContext {
  readonly ui: ObserveUi;
  readonly sessionManager: ObserveSession;
  readonly modelRegistry: ObserveModelRegistry;
  isIdle(): boolean;
}

// What a session_start handler may be given: every member the cycle adds to the notice's context is optional, so a host with
// no dialogs (print, RPC without them, a test) is a context the guard below refuses instead of one that throws.
export interface ObserveStartContext {
  readonly ui: SkillImproveUi;
  readonly sessionManager: ImproveFlowSession & { getSessionDir?(): string; getSessionFile?(): string | undefined };
  readonly hasUI?: boolean;
  readonly mode?: string;
  readonly cwd?: string;
  readonly model?: Model<Api> | undefined;
  readonly modelRegistry?: ObserveModelRegistry;
  isIdle?(): boolean;
}

export function isObserveContext(ctx: ObserveStartContext): ctx is ObserveContext {
  // The ui is read last: pi builds it as a getter, and a context that fails any other check is never asked for it.
  const { sessionManager } = ctx;
  return (
    ctx.hasUI !== false &&
    typeof sessionManager.getSessionDir === "function" &&
    typeof sessionManager.getSessionFile === "function" &&
    typeof ctx.cwd === "string" &&
    ctx.modelRegistry !== undefined &&
    typeof ctx.isIdle === "function" &&
    typeof ctx.ui.select === "function" &&
    typeof ctx.ui.confirm === "function"
  );
}

// The slice of the extension API the observer sends through: only `--review` is dispatched, as a user message that pi expands
// into the extension command.
export interface ObserveRuntimeApi {
  sendUserMessage(content: string, options?: { expandPromptTemplates?: boolean }): unknown;
}

// ---------------------------------------------------------------------------------------------
// The runtime: when a cycle starts, and what stops it
// ---------------------------------------------------------------------------------------------

// What a test replaces. The defaults are pi's agent directory, the settings reader of src/config.ts, the clock of the package,
// the production dependencies below and the cycle itself.
export interface ObserveSeams {
  agentDir?: () => string;
  readConfig?: (agentDir: string) => ObserveConfig;
  now?: () => Date;
  cycleDeps?: (ctx: ObserveContext, api: ObserveRuntimeApi, options: CycleWireOptions) => Promise<CycleDeps>;
  run?: (input: CycleInput, deps: CycleDeps) => Promise<CycleReport>;
}

export interface ObserveRuntime {
  // Starts a background cycle when the session may host one; always answers at once, never throws.
  start(event: { readonly reason: string }, ctx: ObserveStartContext): void;
  // The surface the command binds for `--scan` and `--review`, or undefined for a context that has no dialogs to ask with.
  surface(ctx: ObserveStartContext): ObserveSurface | undefined;
  // Aborts every running cycle and review and forgets what was waiting for the next settle. Idempotent.
  stop(): void;
  // The agent went idle: runs the callbacks `dispatchReview` deferred.
  settled(): void;
}

const CYCLE_REASONS: readonly string[] = ["startup", "new"];

export function createObserveRuntime(api: ObserveRuntimeApi, seams: ObserveSeams = {}): ObserveRuntime {
  const agentDirOf = seams.agentDir ?? getAgentDir;
  const readConfig = seams.readConfig ?? readObserveConfigOf;
  const now = seams.now ?? currentTime;
  const cycleDeps = seams.cycleDeps ?? productionCycleDeps;
  const run = seams.run ?? runObserveCycle;

  const running = new Set<AbortController>();
  let background: AbortController | null = null;
  let waiting: (() => void)[] = [];

  const defer = (callback: () => void): void => {
    waiting.push(callback);
  };

  const warn = (ctx: ObserveContext | ObserveStartContext, message: string): void => {
    try {
      ctx.ui.notify(message, "warning");
    } catch {
      // The context is stale when the session already ended: there is nobody to tell.
    }
  };

  return {
    start(event, ctx) {
      // Only a session somebody just opened: a resume or a fork was already scanned from its parent, a reload follows an acceptance.
      if (!CYCLE_REASONS.includes(event.reason)) return;
      if (ctx.mode !== "tui") return;
      if (!isObserveContext(ctx)) return;
      const sessionFile = ctx.sessionManager.getSessionFile();
      // A session with no file is in memory: there is no root to take its siblings from.
      if (sessionFile === undefined) return;

      const agentDir = agentDirOf();
      let config: ObserveConfig;
      try {
        config = readConfig(agentDir);
      } catch (error) {
        warn(ctx, `The observer did not start: ${toErrorMessage(error)}`);
        return;
      }
      if (!config.enabled) return;
      // A subagent run is nested one directory deeper than a top-level session.
      if (!isTopLevelSessionFile(sessionFile, sessionsRootOf(ctx.sessionManager.getSessionDir()))) return;

      background?.abort();
      const own = new AbortController();
      background = own;
      running.add(own);

      void (async () => {
        const deps = await cycleDeps(ctx, api, {
          agentDir,
          config,
          now,
          onSettled: (callback) => {
            if (!own.signal.aborted) defer(callback);
          },
        });
        if (own.signal.aborted) return;
        await run(
          { mode: "background", config, now: now(), currentSessionFile: sessionFile, ctxCwd: ctx.cwd, signal: own.signal },
          deps,
        );
      })()
        .catch((error: unknown) => {
          // An aborted cycle fails because the session it belongs to is gone, and says nothing.
          if (!own.signal.aborted) warn(ctx, `The observer stopped: ${toErrorMessage(error)}`);
        })
        .finally(() => {
          running.delete(own);
        });
    },

    surface(ctx) {
      if (!isObserveContext(ctx)) return undefined;
      // The command has nothing to abort with, so the surface is stopped by the shutdown of the session like the background cycle.
      const tracked = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const own = new AbortController();
        running.add(own);
        try {
          return await work(own.signal);
        } finally {
          running.delete(own);
        }
      };

      return {
        scan: (input) =>
          tracked(async (signal) => {
            const agentDir = agentDirOf();
            const config = readConfig(agentDir);
            const wired = await cycleDeps(ctx, api, { agentDir, config, now, onSettled: defer });
            // The command reviews inline with its own context, the only one that can reload: the cycle reports
            // "review-dispatched" and the id, and sends no nested message of its own.
            const deps: CycleDeps = { ...wired, dispatchReview: () => undefined };
            return await run(
              {
                mode: input.mode,
                config,
                now: now(),
                currentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
                ctxCwd: ctx.cwd,
                signal,
                ...(input.since === undefined ? {} : { since: input.since }),
                ...(input.sampleSize === undefined ? {} : { sampleSize: input.sampleSize }),
              },
              deps,
            );
          }),

        review: (id, reviewCtx) =>
          tracked(async (signal): Promise<ReviewResult> => {
            const deps = productionReviewDeps(ctx, { agentDir: agentDirOf(), now });
            const context = {
              ui: reviewCtx.ui,
              signal: reviewCtx.signal === undefined ? signal : AbortSignal.any([reviewCtx.signal, signal]),
            };
            if (id !== undefined) return await reviewProposal(id, context, deps);

            // No id: the newest proposal that still has something to review. A proposal with nothing left to review answers before
            // it reads, gates or asks anything, so asking in order costs nothing.
            // Only the latest proposal of a pattern is live: an earlier one was superseded by a restaging and is never offered again.
            const proposals = sortedByAt(latestPerPattern((await deps.readState()).proposals)).reverse();
            for (const proposal of proposals) {
              const result = await reviewProposal(proposal.id, context, deps);
              if (result !== "nothing-to-review") return result;
            }
            return "nothing-to-review";
          }),
      };
    },

    stop() {
      for (const controller of running) controller.abort();
      running.clear();
      background = null;
      waiting = [];
    },

    settled() {
      const callbacks = waiting;
      waiting = [];
      for (const callback of callbacks) {
        try {
          callback();
        } catch {
          // dispatchReview's callbacks report their own failures; one that throws must not keep the others from running.
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Shared environment and helpers
// ---------------------------------------------------------------------------------------------

// What the gate, the proposal view and the acceptance need: the same for the cycle and for `--review`.
interface GateEnv {
  base: string;
  agentDir: string;
  ctx: ImproveFlowContext;
  sriConfig: SriConfig;
  now(): Date;
}

interface CycleEnv extends GateEnv {
  ctx: ObserveContext;
  observe: ObserveConfig;
  skills: readonly SkillRef[];
}

export interface CycleWireOptions {
  agentDir: string;
  config: ObserveConfig;
  // Registers a callback for the next time the agent is idle (the wiring runs it from `agent_settled`).
  onSettled(callback: () => void): void;
  now?: () => Date;
  // Directories whose sessions are scratch runs, besides /tmp and /private/tmp: the platform's temp directory by default.
  tmpdirs?: readonly string[];
}

const KNOWN_PATTERNS_FOR_JUDGE = 20;
const NEW_PATTERN = "new";
const SHOWN_OBSERVATIONS_IN_FOCUS = 5;
const REJECTED_LESSON_CODE_POINTS = 400;
const MAX_REJECTED_LESSONS_IN_FOCUS = 3;
const NOT_REFUSALS: readonly string[] = ["accepted", "stale"];

// What a judge call reads of an episode. The user's own words are always kept; the agent's text and the tool output are what
// is left of the budget. The same number bounds the cost estimate of a dry run, which is therefore an upper bound.
export const JUDGE_TRANSCRIPT_MAX_CODE_POINTS = 24_000;
const TURN_CAPS = { user: 1_500, assistant: 800, tool: 300 } as const;

function platformTmpdirs(): string[] {
  const tmp = os.tmpdir();
  try {
    return [tmp, fs.realpathSync(tmp)];
  } catch {
    return [tmp];
  }
}

function sortedByAt<T extends { at: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.at.localeCompare(right.at));
}

async function readState(env: Pick<GateEnv, "base" | "now">): Promise<ObserveState> {
  return foldObserveState(await readObserveLog(env.base), env.now());
}

function latestPerPattern(proposals: readonly ProposalEvent[]): ProposalEvent[] {
  const byPattern = new Map<string, ProposalEvent>();
  for (const proposal of proposals) {
    const known = byPattern.get(proposal.patternId);
    byPattern.set(proposal.patternId, known === undefined ? proposal : (latestBy([known, proposal]) as ProposalEvent));
  }
  return [...byPattern.values()];
}

function observationsOf(state: ObserveState, patternId: string): ObservationEvent[] {
  return sortedByAt(state.observations.filter((observation) => observation.patternId === patternId));
}

// The label the observer gives a mechanical flag is the flag itself; the judge's is a kebab phrase.
function typeTokensOf(observation: ObservationEvent): string[] {
  return observation.source === "mechanical" ? [observation.kind] : observation.kind.split("-").filter((token) => token !== "");
}

function patternsOfSkill(state: ObserveState, skill: string): { id: string; observations: ObservationEvent[] }[] {
  const byPattern = new Map<string, ObservationEvent[]>();
  for (const observation of state.observations) {
    if (observation.skill !== skill) continue;
    byPattern.set(observation.patternId, [...(byPattern.get(observation.patternId) ?? []), observation]);
  }
  return [...byPattern].map(([id, observations]) => ({ id, observations: sortedByAt(observations) }));
}

function knownPatternsOf(state: ObserveState, skill: string): KnownPattern[] {
  return patternsOfSkill(state, skill).map(({ id, observations }) => ({ id, typeTokens: typeTokensOf(observations[0]!) }));
}

function judgeModelOf(env: Pick<CycleEnv, "ctx" | "observe">): { model: Model<Api>; identity: string } | null {
  const pinned = env.observe.judgeModel;
  const model = pinned === null ? env.ctx.model : env.ctx.modelRegistry.find?.(pinned.provider, pinned.id);
  if (model === undefined) return null;
  const identity = modelIdentity(model.provider, model.id);
  return identity === undefined ? null : { model, identity };
}

function completeOf(env: CycleEnv, model: Model<Api>, signal?: AbortSignal) {
  return createModelCall({
    registry: env.ctx.modelRegistry,
    model,
    sessionId: env.ctx.sessionManager.getSessionId(),
    ...(signal === undefined ? {} : { signal }),
  });
}

function assistantTextOf(content: AssistantMessage["content"]): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "toolCall") parts.push(`[tool call: ${part.name}]`);
  }
  return parts.join("\n");
}

function redactedCut(text: string, max: number): string {
  return cutCodePoints(redactSecrets(text).text, max);
}

// The turns of the episode, redacted, between its first and last entry. Order is the file's.
function transcriptOf(episode: Episode, entries: readonly FileEntry[]): JudgeTurn[] {
  const idOf = (entry: FileEntry): string | undefined => (entry.type === "session" ? undefined : entry.id);
  const start = entries.findIndex((entry) => idOf(entry) === episode.startEntryId);
  const end = entries.findIndex((entry) => idOf(entry) === episode.endEntryId);
  if (start === -1 || end === -1 || end < start) return [];

  const turns: JudgeTurn[] = [];
  for (const entry of entries.slice(start, end + 1)) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    let turn: JudgeTurn | undefined;
    if (message.role === "user") {
      turn = { entryId: entry.id, role: "user", text: redactedCut(splitSkillBlock(textOf(message.content)).userText, TURN_CAPS.user) };
    } else if (message.role === "assistant") {
      turn = { entryId: entry.id, role: "assistant", text: redactedCut(assistantTextOf(message.content), TURN_CAPS.assistant) };
    } else if (message.role === "toolResult") {
      const text = `${message.toolName}${message.isError ? " (error)" : ""}: ${textOf(message.content)}`;
      turn = { entryId: entry.id, role: "tool", text: redactedCut(text, TURN_CAPS.tool) };
    }
    if (turn !== undefined && turn.text.trim() !== "") turns.push(turn);
  }

  let remaining =
    JUDGE_TRANSCRIPT_MAX_CODE_POINTS - turns.filter((turn) => turn.role === "user").reduce((sum, turn) => sum + [...turn.text].length, 0);
  return turns.filter((turn) => {
    if (turn.role === "user") return true;
    const length = [...turn.text].length;
    if (length > remaining) return false;
    remaining -= length;
    return true;
  });
}

function checkLineOf(check: CaseCheck): string {
  return "value" in check
    ? `${check.kind} ${JSON.stringify(check.value)}`
    : `${check.kind} /${check.pattern}/${check.flags ?? ""}`;
}

async function readLessonText(base: string, stagingPath: string): Promise<string | null> {
  const dir = path.resolve(base, stagingPath, LESSONS_DIR);
  try {
    const names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    if (names[0] === undefined) return null;
    const raw = await fs.promises.readFile(path.join(dir, names[0]), "utf8");
    const parsed = parseLesson(raw);
    return parsed.ok ? `${parsed.value.title}\n${parsed.value.body}` : raw;
  } catch (error) {
    // Erased by --forget, or never written: the dialog says so instead of showing nothing. Any other failure is not that.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The proposal view (what the dialogs show)
// ---------------------------------------------------------------------------------------------

const MIN_PATTERN_SUMMARY_CHARS = 12;

// One line for the pattern: the shortest summary of its observations that has at least MIN_PATTERN_SUMMARY_CHARS characters (a
// fragment like "no bullets" says too little); when none has, the shortest one there is.
function patternSummaryOf(observations: readonly ObservationEvent[]): string {
  const texts = observations.map(({ summary }) => summary.trim()).filter((text) => text !== "");
  const byLength = (a: string, b: string): number => a.length - b.length;
  const long = texts.filter((text) => text.length >= MIN_PATTERN_SUMMARY_CHARS).sort(byLength)[0];
  const chosen = long ?? [...texts].sort(byLength)[0];
  return chosen === undefined ? "(no observation left in the store)" : cutCodePoints(chosen, MAX_SUMMARY_CHARS);
}

// `realRuns` is the most real runs the gate plans for this proposal (arms x repetitions x cases, from the gate's own design),
// never how often the pattern was seen. A probation proposal is not gated and plans none.
export async function proposalViewOf(
  env: Pick<GateEnv, "base" | "now">,
  state: ObserveState,
  proposal: ProposalEvent,
  view?: PatternView,
): Promise<ProposalView> {
  const pattern = view ?? patternViews(state, env.now()).find((candidate) => candidate.id === proposal.patternId);
  const observations = observationsOf(state, proposal.patternId);

  let bank: ProposalView["bank"] = null;
  if (proposal.gate === "bank" && proposal.bankPath !== null) {
    const loaded = await readCaseBank(proposal.bankPath, "baseline");
    const cases: BankCaseView[] = loaded.ok
      ? loaded.value.bank.cases.map((entry) => ({ id: entry.id, prompt: entry.prompt, checks: entry.checks.map(checkLineOf) }))
      : [];
    bank = { provenance: proposal.provenance, cases };
  }

  return {
    skill: proposal.skill,
    patternSummary: patternSummaryOf(observations),
    observations: observations.map((observation) => observation.summary),
    sessions: pattern?.sessions ?? new Set(observations.map((observation) => observation.sessionId)).size,
    days: pattern?.days ?? 0,
    realRuns: bank === null || bank.cases.length === 0 ? 0 : planDesign(bank.cases.length, "case-bank").design.plannedRuns,
    lesson: (await readLessonText(env.base, proposal.stagingPath)) ?? "(the text of the lesson is no longer on disk)",
    gate: proposal.gate,
    cwd: proposal.cwd,
    bank,
  };
}

// ---------------------------------------------------------------------------------------------
// The gate and the acceptance of one proposal (shared by the cycle and `--review`)
// ---------------------------------------------------------------------------------------------

function replayAllowed(agentDir: string, skill: string): boolean {
  return readObserveConfigOf(agentDir).replayAllow.includes(skill);
}

async function gateProposal(
  env: GateEnv,
  proposal: ProposalEvent,
  bankPath: string | null,
  signal?: AbortSignal,
): Promise<Result<GateFlowResult | DirectionalGateResult, string>> {
  if (proposal.gate !== "bank" || bankPath === null) {
    throw new SriFailClosedError(`the proposal ${quote(proposal.id)} has no bank: a lesson on probation is not gated`);
  }
  // The setting is read again here and not trusted from the proposal: a skill the user took out of the list since is not replayed.
  if (!replayAllowed(env.agentDir, proposal.skill)) {
    return {
      ok: false,
      error: `the skill ${quote(proposal.skill)} is not in "pi-simple-sri.observe.replay.allow" any more: nothing was replayed`,
    };
  }
  const skill = findSkill(await listSkills({ cwd: env.ctx.cwd, agentDir: env.agentDir }), proposal.skill);
  if (skill === undefined) throw new SriFailClosedError(`the skill ${quote(proposal.skill)} is not installed any more: nothing was gated`);

  const request: GateRequest = {
    base: env.base,
    agentDir: env.agentDir,
    // The cwd the bank's cases were seen in, not the session's.
    cwd: proposal.cwd,
    stagingPath: proposal.stagingPath,
    skill,
    config: env.sriConfig,
    ...(signal === undefined ? {} : { signal }),
  };
  const wired = wireDirectionalGate({
    context: env.ctx,
    sessionId: env.ctx.sessionManager.getSessionId(),
    request,
    bankPath,
  });
  if (!wired.ok) return { ok: false, error: wired.error };
  return { ok: true, value: await gateDirectionalCandidate(wired.value.request, wired.value.deps) };
}

// The refusal `accept` answers for a proposal staged before the digest was recorded. `AcceptRejection.reason` does not list it.
export const NO_HASH_REASON = "no-hash";

// Accepts what the user confirmed: the lesson the record declares, into the skill, under the digest of the SKILL.md recorded when
// the proposal was staged (`proposal.skillContentHash`), never one computed now: a skill edited since is refused as drift. A
// probation candidate never had a gate, and a bank that could not measure the lesson (`not-measurable`) left a record that says
// so; both records are turned into the probation one here.
async function acceptProposal(
  env: GateEnv,
  proposal: ProposalEvent,
  outcome: GateClassification,
  acceptDeps?: AcceptDeps,
): Promise<AcceptOutcome> {
  if (proposal.gate === "bank" && outcome.class !== "accepted" && outcome.class !== "not-measurable") {
    throw new SriFailClosedError(
      `the gate did not accept the lesson (${outcome.status}): only a lesson the gate accepted, or one the bank could not measure, is accepted`,
    );
  }
  const skillContentHash: unknown = proposal.skillContentHash;
  if (typeof skillContentHash !== "string" || skillContentHash === "") {
    // A refusal the review closes the proposal on (like skill-drift), not a failure: such a proposal can never be accepted.
    const reason = NO_HASH_REASON as string as AcceptRejection["reason"];
    return {
      ok: false,
      error: {
        reason,
        detail: `the proposal ${quote(proposal.id)} carries no skillContentHash from its staging: nothing was accepted, propose again`,
      },
    };
  }

  const skill = findSkill(await listSkills({ cwd: env.ctx.cwd, agentDir: env.agentDir }), proposal.skill);
  if (skill === undefined) throw new SriFailClosedError(`the skill ${quote(proposal.skill)} is not installed any more: nothing was accepted`);

  const resolved = await resolveStagedCandidate(env.base, skill.name, proposal.stagingPath);
  if (!resolved.ok) {
    throw new SriWriterError(`the candidate of the proposal ${quote(proposal.id)} cannot be read: ${resolved.error.detail}`, proposal.stagingPath);
  }

  let record = resolved.value;
  const unmeasured =
    (proposal.gate === "probation" && record.gate.status === "not-run") ||
    (proposal.gate === "bank" && outcome.class === "not-measurable" && record.gate.status === "gate-abstained");
  if (unmeasured) record = probationRecordOf(record, skillContentHash, env.now());
  if (record.gate.status !== "gate-accepted" && record.gate.status !== "probation") {
    throw new SriWriterError(`the record of the proposal ${quote(proposal.id)} says ${quote(record.gate.status)}: nothing was accepted`, proposal.stagingPath);
  }

  const lesson = await verifiedStagedLesson(path.resolve(env.base, proposal.stagingPath), record);
  if (!lesson.ok) {
    throw new SriWriterError(`the candidate of ${quote(proposal.id)} no longer holds the lesson its record declares: ${lesson.error}`, proposal.stagingPath);
  }

  return await acceptCandidate(
    {
      base: env.base,
      skill: { name: skill.name, realDir: skill.realDir },
      candidate: { slug: record.candidate.slug, title: record.candidate.title, lessonText: lesson.value, contentHash: record.candidate.contentHash },
      decision: record,
      expectedSkillContentHash: skillContentHash,
      eligibility: eligibilityOfSkill(skill, env.sriConfig),
      failureSignature: record.diagnosis.failureSignature,
    },
    acceptDeps,
  );
}

// The ledger says the lesson of this candidate is in the skill already.
async function isAcceptedIn(base: string, proposal: ProposalEvent): Promise<boolean> {
  const ledger = await readLedger(base);
  return ledger.lines.some((entry) => entry.line.event === "accepted" && entry.line.candidateHash === proposal.candidateHash);
}

// Writes the approved draft of an auto bank to banks/ and answers the final path. Asked again for the same approved bank (the
// gate was retryable), it answers the file that is already there.
async function promoteDraft(base: string, draftPath: string, skill: string): Promise<string> {
  const root = banksDir(base);
  const resolvedDraft = path.resolve(draftPath);
  // The bank the skill already has (promoted by an earlier cycle and found again by `resolve`) is the one to gate.
  if (resolvedDraft === path.resolve(bankPathOf(base, skill))) return resolvedDraft;
  if (path.relative(stagingDir(base), resolvedDraft).startsWith("..")) {
    throw new SriFailClosedError(`the bank draft ${quote(draftPath)} is not inside the staging directory: nothing was promoted`);
  }
  const text = await fs.promises.readFile(resolvedDraft, "utf8");
  ensurePrivateDir(root, base);
  const target = bankPathOf(base, skill);
  if (await createExclusiveFile(target, text, root)) return target;
  if ((await fs.promises.readFile(target, "utf8")) === text) return target;
  throw new SriFailClosedError(`a different bank already exists at ${quote(target)}: the approved one was not written`);
}

// The bank a proposal is gated against: the approved draft of an auto bank is promoted first, any other bank is where it was.
// Null for a proposal with no bank.
async function bankToGate(env: Pick<GateEnv, "base" | "agentDir">, proposal: ProposalEvent): Promise<string | null> {
  if (proposal.gate !== "bank" || proposal.bankPath === null) return null;
  // Before anything is written: a skill taken out of the list since is neither promoted nor replayed.
  if (!replayAllowed(env.agentDir, proposal.skill)) {
    throw new SriFailClosedError(
      `the skill ${quote(proposal.skill)} is not in "pi-simple-sri.observe.replay.allow" any more: no bank was promoted and nothing was replayed`,
    );
  }
  return proposal.provenance === "auto" ? await promoteDraft(env.base, proposal.bankPath, proposal.skill) : proposal.bankPath;
}

// The dependencies of `reviewProposal` (src/observe/review.ts) for the command `--review`. Nothing here reloads.
export function productionReviewDeps(
  ctx: ImproveFlowContext,
  options: { agentDir: string; now?: () => Date; acceptDeps?: AcceptDeps },
): ReviewDeps {
  const env: GateEnv = {
    base: writeBase(options.agentDir),
    agentDir: options.agentDir,
    ctx,
    sriConfig: readSriConfigOf(options.agentDir),
    now: options.now ?? currentTime,
  };

  return {
    now: env.now,
    readState: () => readState(env),
    isAccepted: (proposal) => isAcceptedIn(env.base, proposal),
    promoteBank: (proposal) => bankToGate(env, proposal),
    viewOf: async (proposal) => proposalViewOf(env, await readState(env), proposal),
    runGate: async (proposal, bankPath, signal) => {
      // The review hands over the promoted path; the promotion is idempotent, so a null path is promoted here before the gate runs.
      const gated = await gateProposal(env, proposal, bankPath ?? (await bankToGate(env, proposal)), signal);
      if (!gated.ok) throw new SriFailClosedError(`the gate cannot run: ${gated.error}`);
      return gated.value;
    },
    accept: (proposal, outcome) => acceptProposal(env, proposal, outcome, options.acceptDeps),
    append: (events) => appendObserveEvents(env.base, events),
  };
}

// ---------------------------------------------------------------------------------------------
// The dependencies of the cycle
// ---------------------------------------------------------------------------------------------

// What a case of an auto bank is made of, as `select` hands it to `generate`. The cycle treats the list as opaque.
interface SelectedCase {
  episodeId: string;
  prompt: string;
  expectation: string;
}

function isSelectedCase(value: unknown): value is SelectedCase {
  if (typeof value !== "object" || value === null) return false;
  const { episodeId, prompt, expectation } = value as Record<string, unknown>;
  return typeof episodeId === "string" && typeof prompt === "string" && typeof expectation === "string";
}

// The ask the proposer is given: what the pattern is, and what was already refused for it, so it does not offer the same
// lesson again.
async function focusOf(env: CycleEnv, state: ObserveState, view: PatternView): Promise<string> {
  const observations = observationsOf(state, view.id);
  const lines = [
    `Recurring correction pattern in skill ${view.skill}, seen in ${view.sessions} sessions over ${view.days} days:`,
    ...observations.slice(0, SHOWN_OBSERVATIONS_IN_FOCUS).map((observation) => `- ${observation.summary}`),
  ];

  // An accepted lesson is in the skill and a stale one was closed by drift: neither was refused on its merits.
  const refused = new Set(
    state.tombstones
      .filter((tombstone) => tombstone.patternId === view.id && tombstone.candidateHash !== null && !NOT_REFUSALS.includes(tombstone.reason))
      .map((tombstone) => tombstone.candidateHash),
  );
  const rejected: string[] = [];
  for (const proposal of state.proposals) {
    if (rejected.length >= MAX_REJECTED_LESSONS_IN_FOCUS) break;
    if (proposal.patternId !== view.id || !refused.has(proposal.candidateHash)) continue;
    const text = await readLessonText(env.base, proposal.stagingPath);
    if (text !== null) rejected.push(`- ${cutCodePoints(text, REJECTED_LESSON_CODE_POINTS)}`);
  }
  if (rejected.length > 0) lines.push("Candidates already rejected for this pattern; propose something different:", ...rejected);
  return lines.join("\n");
}

function pricedOf(env: CycleEnv): { cost: { input: number; output: number } } | null {
  return judgeModelOf(env)?.model ?? null;
}

export async function productionCycleDeps(
  ctx: ObserveContext,
  api: ObserveRuntimeApi,
  options: CycleWireOptions,
): Promise<CycleDeps> {
  const now = options.now ?? currentTime;
  const base = writeBase(options.agentDir);
  const sriConfig = readSriConfigOf(options.agentDir);
  // The inventory is read once because segmentation is synchronous; a skill that is not in it (another project's) is not segmented
  // implicitly and has no description for the judge.
  const skills = await listSkills({ cwd: ctx.cwd, agentDir: options.agentDir });
  const env: CycleEnv = { base, agentDir: options.agentDir, ctx, sriConfig, now, observe: options.config, skills };
  const sessions = sessionsRootOf(ctx.sessionManager.getSessionDir());
  const tmpdirs = options.tmpdirs ?? platformTmpdirs();

  const observable = (name: string): boolean => {
    const skill = findSkill(skills, name);
    return (skill === undefined ? isEligible(name, sriConfig) : eligibilityOfSkill(skill, sriConfig)).eligible;
  };
  const descriptionOf = (name: string): string => findSkill(skills, name)?.description ?? "";
  const reviewApi: ReviewApi = {
    sendUserMessage: (text, sendOptions) => api.sendUserMessage(text, sendOptions),
    notify: (message, type) => ctx.ui.notify(message, type),
  };

  return {
    store: {
      readEvents: () => readObserveLog(base),
      append: (events) => appendObserveEvents(base, events),
      readCursor: () => readCursor(base),
      writeCursor: (cursor) => writeCursor(base, cursor),
      withLock: (fn) => withScanLock(base, fn),
    },
    fold: foldObserveState,
    listSessions: () => listTopLevelSessionFiles(sessions),
    planScan,
    readSession: readSessionFile,
    // A session run in a scratch directory (a replay child, a throwaway run) or in one that is gone is not read: nothing in it
    // could be replayed, and it is not the user's work (Q6).
    segment: (read, ref) =>
      isExcludedCwd(read.header.cwd, isDirectory, tmpdirs) ? [] : segmentEpisodes(read, ref, skills, observable),
    prefilter: (episode, read) => prefilterEpisode(episode, read.entries, read.header.cwd),
    providerOk: (episode) => {
      const provider = options.config.judgeModel?.provider ?? ctx.model?.provider;
      return provider !== undefined && providerGate(episode, { provider, pinned: options.config.judgeModel !== null }) === "ok";
    },

    judge: async ({ episode, read, state }, signal): Promise<CycleVerdict> => {
      const resolved = judgeModelOf(env);
      if (resolved === null) return { outcome: "skipped", model: "", findings: [], reason: "no judge model" };

      const patterns = patternsOfSkill(state, episode.skill)
        .sort((left, right) => right.observations.at(-1)!.at.localeCompare(left.observations.at(-1)!.at))
        .slice(0, KNOWN_PATTERNS_FOR_JUDGE)
        .map(({ id, observations }) => ({ id, summary: observations[0]!.summary, typeTokens: typeTokensOf(observations[0]!) }));
      const input: JudgeInput = {
        episode,
        skill: { name: episode.skill, description: descriptionOf(episode.skill) },
        turns: transcriptOf(episode, read.entries),
        patterns,
      };
      const verdict = await createEpisodeJudge(completeOf(env, resolved.model, signal))(input, signal);
      if (!verdict.ok) return { outcome: "failed", model: resolved.identity, findings: [], reason: verdict.reason };
      return { outcome: verdict.findings.length > 0 ? "findings" : "clean", model: resolved.identity, findings: verdict.findings };
    },

    assignPattern: (finding, state, skill) => {
      const probe: JudgeFinding = { kind: "", summary: "", confidence: 0, anchorEntryId: "", ...finding };
      const id = assignPattern(probe, knownPatternsOf(state, skill));
      return id === NEW_PATTERN ? null : id;
    },
    redact: (text) => redactSecrets(text).text,
    // The header line as pi wrote it is not kept by the reader; its re-serialisation is stable and only informs a later version.
    cursorEntryOf: (ref, read) => entryOfCursor(ref, JSON.stringify(read.header)),

    estimateCost: (episodes): CostEstimate => {
      const filler = "x".repeat(JUDGE_TRANSCRIPT_MAX_CODE_POINTS);
      const inputs: JudgeInput[] = episodes.map((episode) => ({
        episode,
        skill: { name: episode.skill, description: descriptionOf(episode.skill) },
        turns: [{ entryId: episode.startEntryId, role: "user", text: filler }],
        patterns: [],
      }));
      return estimateJudgeCost(inputs, pricedOf(env));
    },
    confirmDryRun: (estimate) => {
      const cost = estimate.usd === null ? "" : ` (about $${estimate.usd.toFixed(2)})`;
      return ctx.ui.confirm(
        "Scan sessions (dry run)",
        `The judge ${judgeModelOf(env)?.identity ?? "(no model)"} will read up to ${estimate.calls} episodes: at most ${estimate.inTokens} input and ${estimate.outTokens} output tokens${cost}. Nothing is written to the observer store. Continue?`,
      );
    },
    writeLabeling: async (fileName, text) => {
      const root = labelingDir(base);
      ensurePrivateDir(root, base);
      await writePrivateFile(path.join(root, fileName), text, root);
    },
    proposable: (state, at) => proposablePatterns(patternViews(state, at), state, at),

    bank: {
      resolve: async (skillName) => {
        const skill = findSkill(skills, skillName);
        if (skill === undefined) return null;
        const resolved = await resolveBank(base, skill);
        if (resolved.kind === "found") return { path: resolved.path, provenance: resolved.provenance };
        // An existing bank that cannot be read is not the absence of a bank: a generated one would replace it.
        if (resolved.kind === "unusable") {
          throw new SriFailClosedError(`the case bank ${quote(resolved.path)} exists and cannot be used as a bank: fix or remove it`);
        }
        return null;
      },

      select: async (view, state, ctxCwd): Promise<BankSelectionResult> => {
        const observed = new Set(view.observationIds);
        const episodeIds = new Set(state.observations.filter((o) => observed.has(o.id) && o.episodeId !== null).map((o) => o.episodeId));
        const wanted = state.episodes.filter((episode) => episodeIds.has(episode.id) && episode.skill === view.skill);

        // The verbatim words the user opened each episode with: the first of its anchors that holds text.
        const prompts = new Map<string, string>();
        for (const file of new Set(wanted.map((episode) => episode.sessionFile))) {
          const read = await readSessionFile(file);
          if (!read.ok) continue;
          const typed = new Map(userAuthoredTurns(read.value.entries).map((turn) => [turn.anchorEntryId, turn.text]));
          for (const episode of wanted.filter((candidate) => candidate.sessionFile === file)) {
            const first = episode.anchorEntryIds.find((anchor) => typed.has(anchor));
            if (first !== undefined) prompts.set(episode.id, typed.get(first) as string);
          }
        }

        const selection = selectBankEpisodes(view, state, ctxCwd, isDirectory, (episode: EpisodeEvent) => prompts.get(episode.id) ?? null);
        if ("pending" in selection) return { kind: "pending", reason: selection.reason };

        const cases: SelectedCase[] = selection.episodes.map((episode) => ({
          episodeId: episode.id,
          prompt: prompts.get(episode.id) as string,
          expectation: state.observations
            .filter((o) => observed.has(o.id) && o.episodeId === episode.id)
            .map((o) => o.summary)
            .join("; "),
        }));
        return { kind: "ready", selection: { cwd: selection.cwd, episodes: cases } satisfies BankSelection };
      },

      generate: async ({ skill, selection }, signal): Promise<Result<string, string>> => {
        const resolved = judgeModelOf(env);
        if (resolved === null) return { ok: false, error: "no model to write the bank with" };
        const cases = selection.episodes.filter(isSelectedCase);
        const generated = await createBankGenerator(completeOf(env, resolved.model, signal))(
          { skill: { name: skill, description: descriptionOf(skill) }, cases, now: now() },
          signal,
        );
        if (!generated.ok) return generated;

        // The draft waits in staging, outside the banks the gate reads, until the user approves it.
        const text = `${JSON.stringify(generated.value, null, 2)}\n`;
        const root = stagingDir(base);
        ensurePrivateDir(root, base);
        const draft = path.join(root, "observer-banks", `${skill}-${sha256Hex(text).slice(0, 12)}`, CASE_BANK_FILE);
        await writePrivateFile(draft, text, root);
        return { ok: true, value: draft };
      },

      // A skill taken out of the replay list since the draft was approved is not promoted: the draft goes on to the gate, which
      // refuses it as retryable, and no bank is written.
      promote: async (draftPath, skill) => (replayAllowed(options.agentDir, skill) ? await promoteDraft(base, draftPath, skill) : draftPath),
    },

    propose: async ({ view, state, gate, bankPath }, signal): Promise<Result<ProposalDraft, string>> => {
      const request: ImproveRequest = {
        surface: "observer",
        skillName: view.skill,
        focus: await focusOf(env, state, view),
        observed: { patternId: view.id, gate },
        ...(bankPath === null ? {} : { bankPath }),
        ...(signal === undefined ? {} : { signal }),
      };
      try {
        // The digest of the SKILL.md the lesson is written against, taken before the proposer reads it and kept in the proposal:
        // the acceptance compares the skill with it and never with one computed when the user accepts.
        const skill = findSkill(skills, view.skill);
        if (skill === undefined) return { ok: false, error: `the skill ${quote(view.skill)} is not installed: nothing was proposed` };
        const skillContentHash = sha256Digest(await fs.promises.readFile(path.join(skill.realDir, SKILL_FILE)));
        const result = await proposeSkill(request, ctx, { agentDir: options.agentDir, config: sriConfig, now });
        if (result.kind === "proposed") {
          return {
            ok: true,
            value: { stagingPath: result.staged.stagingPath, candidateHash: result.entry.candidateHash, skillContentHash },
          };
        }
        return { ok: false, error: result.kind === "refused" ? result.reason : result.kind };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },

    runGate: async ({ proposal, bankPath }, signal): Promise<GateOutcomeView> => {
      try {
        const gated = await gateProposal(env, proposal, bankPath, signal);
        return gated.ok ? classifyGateResult(gated.value) : { class: "retryable", status: gated.error, reason: gated.error };
      } catch (error) {
        return { class: "retryable", status: "error", reason: toErrorMessage(error) };
      }
    },

    offerA: async (offer, signal) => {
      const view = await proposalViewOf(env, await readState(env), offer.proposal, offer.view);
      return offerProposal(view, ctx.ui, signal === undefined ? {} : { signal });
    },
    offerB: async (offer, signal) => {
      const view = await proposalViewOf(env, await readState(env), offer.proposal, offer.view);
      return offerAcceptance(view, offer.outcome, ctx.ui, signal === undefined ? {} : { signal });
    },
    isAccepted: (proposal) => isAcceptedIn(base, proposal),
    // What a cycle made for a skill the user forgot meanwhile goes with the helpers of `--forget`.
    discardArtifacts: async (skill) => {
      await discardSkillArtifacts(base, skill);
    },
    dispatchReview: (proposalId) => dispatchReview(reviewApi, () => ctx.isIdle(), options.onSettled, proposalId, "deferred-command"),
  };
}
