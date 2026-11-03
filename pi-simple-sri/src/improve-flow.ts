import fs from "node:fs";
import path from "node:path";
import type { Api, AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { readSriConfig } from "./config.ts";
import { buildDiagnosis } from "./diagnosis.ts";
import { isEligibleUnderAnySpelling } from "./eligibility.ts";
import { deriveEvidence, type DerivedEvidence, type EvidenceContext } from "./evidence.ts";
import { ProposerError, SriFailClosedError, SriWriterError } from "./errors.ts";
import { sha256Digest } from "./hash.ts";
import { serializeLesson } from "./lesson-frontmatter.ts";
import { SKILL_FILE } from "./names.ts";
import { createProposer, type CompleteFn, type GenerationUsage, type ProposeInput, type ProposeResult } from "./proposer.ts";
import { lessonReferencePath } from "./skill-reference.ts";
import { findSkill, listSkills, type ListSkillsOptions } from "./skills-inventory.ts";
import { toDecisionSkill } from "./types.ts";
import type {
  AttemptLine,
  DecisionRecord,
  DecisionSurface,
  Diagnosis,
  Eligibility,
  EvidenceItem,
  LessonDraft,
  SkillRef,
  SriConfig,
} from "./types.ts";
import { quote, toErrorMessage } from "./values.ts";
import {
  appendAttemptLine,
  discardStagingCandidate,
  lessonHashes,
  writeStagingCandidate,
  type LessonHashes,
  type StagingWriteInput,
  type StagingWriteResult,
} from "./writer.ts";

// The loop both surfaces run (P8, P9): one named skill, from the settings and the inventory to a
// candidate in staging, or a documented reason for there being none.
//
//   /skill-improve <skill> [focus]         -> proposeSkill(..., surface "command")
//   skill_improve { action: "diagnose" }   -> diagnoseSkill(...), which writes nothing
//   skill_improve { action: "propose" }    -> proposeSkill(..., surface "tool")
//
// The order below is the contract, and each step exists to stop the next one:
//
//   1. the settings and the inventory resolve the name (Q15, Q16);
//   2. a skill the settings exclude is refused before the model is called, and the refusal is
//      recorded with its reason, so an ineligible skill never spends a generation (Q17, D6);
//   3. the evidence comes from the session branch alone; with none there is no candidate, and the
//      attempt is recorded anyway so "nothing happened" is auditable (D5);
//   4. the session model writes one lesson from a diagnosis of that evidence;
//   5. the lesson and its decision.json go to the package staging tree and the attempt joins the
//      index. The two writes are one unit: a candidate whose line cannot be appended is retired, so
//      the index never disagrees with what sits in staging (F1).
//
// A refusal that produced no candidate leaves a line of its own in the index -- no-evidence,
// not-eligible, no-model -- because the hashes of the attempt are what groups the runs that asked for
// the same thing on the same skill, and a refusal nobody recorded is a run nobody can audit (D5).
//
// M0 never touches a skill: every path taken here writes inside <package>/staging and
// <package>/state, and the acceptance that edits a skill is M1 and lives in its own slice.
//
// What the two surfaces do with a result is the only difference between them, and it stays in
// them: the command reports with a notification and records the session entry, the tool answers
// with a tool result. So this module returns facts -- a union of outcomes, the entry the surface
// may record, the hashes of the attempt -- and never a notification, a tool result or a log line.
//
// A refusal this package raises on purpose travels as a SriFailClosedError: nothing was written
// and the caller decides whether that becomes a warning, an error notification or a tool result
// with isError. The refusals that are data -- no candidate, a lesson the model would not produce
// -- come back in the union instead, because a caller has to record them. The one refusal that
// follows a write is the F1 case: a candidate whose index line failed is retired before the error
// leaves, so "nothing was written" is still true when the caller reads it.
//
// Importing this module reads nothing, registers nothing and starts nothing (rule 9 of the slice).
// The clock, the settings file, the inventory, the model, the writer and the record channels are
// all resolved inside the two entry points; the package root is the one dependency the caller
// resolves, because it is the anchor of the package and not a seam.

// The custom type of the session entry the surfaces record (rule 6 of P8). It is stored through
// appendEntry, so it is visible in /tree and never enters the model context
// (docs/extensions.md:180, :344).
export const ENTRY_TYPE = "skill-improvement";

// pi reads its global settings from <agent dir>/settings.json and derives the directory from the
// environment at the call, not at the import (dist/core/settings-manager.js:123, getAgentDir).
const SETTINGS_FILE = "settings.json";

// What happened to one attempt, as the session entry records it. It is the same set of facts as the
// line in state/attempts.jsonl plus the skill and the focus, so a reader of /tree sees what was
// attempted without opening the index. "error" covers a generation that refused to produce a
// lesson; a refusal raised later in the run is reported and not recorded, because by then the run
// may not know which skill it was working on.
export type ImprovementOutcome = "proposed" | "not-eligible" | "no-evidence" | "error";

// The staged candidate, when the run produced one.
export interface StagedCandidate {
  slug: string;
  stagingPath: string;
  decisionPath: string;
}

export interface ImprovementEntry {
  surface: DecisionSurface;
  skill: string;
  focus: string | null;
  outcome: ImprovementOutcome;
  // Why, in the vocabulary of decision.json: the eligibility reason, the proposer's message, or
  // null when a candidate was staged.
  reason: string | null;
  evidenceCount: number;
  candidateHash: string;
  bodyHash: string;
  staged: StagedCandidate | null;
}

// What the loop reads from the session: the branch of entries the failure evidence is derived
// from, and the identifier of the session itself. ReadonlySessionManager.getBranch() answers
// SessionEntry[], so the entries of other kinds are filtered out at the call site (see
// messageEntries). getSessionId() is not evidence: it is what the single model call has to send
// as `sessionId`, because a provider that routes by session refuses a request without it (the
// opencode-go provider answers 400 MissingSessionID). pi's own agent loop passes it on every
// request; a call made outside that loop has to pass it too.
export interface ImproveFlowSession {
  getBranch(): readonly SessionEntry[];
  getSessionId(): string;
}

// The one model call this package makes, typed exactly after the registry method it forwards to:
// a ModelRegistry satisfies this interface without a conversion, and a test fake only has to
// provide one method.
export interface ImproveFlowModelRegistry {
  complete(
    model: Model<Api>,
    context: Context,
    options?: ModelsApiStreamOptions<Api>,
  ): Promise<AssistantMessage>;
}

// The part of a pi context the loop reads, spelled out instead of taking the whole
// ExtensionToolContext or ExtensionCommandContext: a fake in the tests then costs four fields, and
// a change in pi's context that breaks this contract fails to compile where the wiring passes the
// real context. Both a tool context and a command context satisfy it as it stands.
export interface ImproveFlowContext {
  readonly cwd: string;
  readonly model: Model<Api> | undefined;
  readonly modelRegistry: ImproveFlowModelRegistry;
  readonly sessionManager: ImproveFlowSession;
}

export type ProposeFn = (input: ProposeInput) => Promise<ProposeResult>;

// Every dependency the loop touches, so a test can replace it. readSkillText is here for the same
// reason as the others: the happy path must be provable without a real skill directory on disk.
//
// `root` is the one dependency with no default: it is the anchor of this package, not a seam, and it
// is the caller's to resolve (extensions/index.ts derives it from its own module URL). A fallback here
// would be a second owner of that derivation, and a run under the wrong root would write staging and
// the index into a package nobody asked for.
export interface ImproveFlowDeps {
  root: string;
  // The agent directory pi derives at the call (getAgentDir, dist/core/settings-manager.js:123). The
  // settings file and the skills directory are both read under it, so it is a seam and not a constant:
  // a test proves which directory a run read, and the default is pi's, resolved once per run.
  agentDir?: string;
  now?: () => Date;
  readConfig?: (settingsPath: string) => SriConfig;
  listSkills?: (options: ListSkillsOptions) => Promise<SkillRef[]>;
  readSkillText?: (skill: SkillRef) => Promise<string>;
  propose?: ProposeFn;
  write?: (input: StagingWriteInput) => Promise<StagingWriteResult>;
  appendAttempt?: (root: string, line: AttemptLine) => Promise<void>;
}

// Which surface asked. It is the trigger of decision.json and the surface of the session entry, so
// a record never claims to come from the surface that did not make it.
export interface ImproveRequest {
  surface: DecisionSurface;
  skillName: string;
  // The focus in the one representation the run uses: string | undefined, with a blank value read as
  // absent (normalizeFocus). The published shapes -- the trigger of decision.json and the session
  // entry -- are the only places that spell it as null.
  focus?: string;
  // The abort signal of the surface that asked, when it has one: a tool call carries one pi can
  // abort, a command has nothing to abort with and leaves it absent. It travels to the single model
  // call of the run and nothing else does (F7).
  signal?: AbortSignal;
}

export interface DiagnoseRequest {
  skillName: string;
}

export interface UnknownSkillFlowResult {
  kind: "unknown-skill";
  skillName: string;
  // The skills the settings let through, so the answer can offer the ones the user can improve.
  eligible: readonly SkillRef[];
  // The skill the inventory knows under the same name that has no directory of its own. findSkill
  // refuses it as a target, so the name exists and still cannot be improved; the answer says which of
  // the two happened instead of reporting a skill that is installed as one that is not (F6).
  standalone: SkillRef | null;
}

export interface NotEligibleFlowResult {
  kind: "not-eligible";
  skill: SkillRef;
  reason: string;
  entry: ImprovementEntry;
}

export interface NoEvidenceFlowResult {
  kind: "no-evidence";
  skill: SkillRef;
  entry: ImprovementEntry;
}

export interface NoModelFlowResult {
  kind: "no-model";
  skill: SkillRef;
}

// A generation that refused to produce a lesson. It is data and not a thrown error because the
// surfaces record it: the attempt happened and its reason is part of the audit trail.
export interface RefusedFlowResult {
  kind: "refused";
  skill: SkillRef;
  reason: string;
  entry: ImprovementEntry;
}

export interface ProposedFlowResult {
  kind: "proposed";
  skill: SkillRef;
  evidence: readonly EvidenceItem[];
  diagnosis: Diagnosis;
  draft: LessonDraft;
  usage: GenerationUsage;
  staged: StagingWriteResult;
  entry: ImprovementEntry;
}

export type ProposeFlowResult =
  | UnknownSkillFlowResult
  | NotEligibleFlowResult
  | NoEvidenceFlowResult
  | NoModelFlowResult
  | RefusedFlowResult
  | ProposedFlowResult;

export interface DiagnosedFlowResult {
  kind: "diagnosed";
  skill: SkillRef;
  // The verdict as data: a diagnosis may read any skill (Q17), so an ineligible skill is diagnosed
  // and its verdict reports why a candidate would not be generated.
  eligibility: Eligibility;
  evidence: readonly EvidenceItem[];
  diagnosis: Diagnosis;
}

export interface NoEvidenceDiagnosisFlowResult {
  kind: "no-evidence";
  skill: SkillRef;
  eligibility: Eligibility;
}

export type DiagnoseFlowResult =
  | UnknownSkillFlowResult
  | NoEvidenceDiagnosisFlowResult
  | DiagnosedFlowResult;

// Q15, applied to the inventory: only a declared skill can hold a lesson, and only a skill the
// settings let through is offered for improvement.
export async function listEligibleSkills(
  ctx: ImproveFlowContext,
  deps: ImproveFlowDeps,
): Promise<SkillRef[]> {
  const { config, skills } = await readInventory(ctx, seamsOf(deps));
  return eligibleSkills(skills, config);
}

// The read-only half of the loop: what failed and what a replay would test. It reads the settings,
// the inventory and the branch; it does not call the model, does not write staging, does not append
// to the index and does not leave a session entry (rule 1 of P9).
export async function diagnoseSkill(
  request: DiagnoseRequest,
  ctx: ImproveFlowContext,
  deps: ImproveFlowDeps,
): Promise<DiagnoseFlowResult> {
  const target = await resolveRunTarget(request.skillName, ctx, seamsOf(deps));
  if (target.kind === "unknown-skill") return target;

  const { skill, config } = target;
  const eligibility = eligibilityOf(skill, config);
  const derived = sessionEvidence(ctx);

  // Nothing to diagnose is a refusal with its own answer -- the skill and the verdict a candidate
  // would be judged by -- and not an empty diagnosis.
  if (derived === undefined) {
    return { kind: "no-evidence", skill, eligibility };
  }

  return {
    kind: "diagnosed",
    skill,
    eligibility,
    evidence: derived.items,
    diagnosis: diagnoseEvidence(derived.items, derived.contextById, skill, ctx),
  };
}

// The writing half of the loop: the same steps as diagnoseSkill, plus the generation, the staging
// write and the index line. It never accepts anything: acceptance edits a skill and is M1.
//
// Fail-closed refusals -- a diagnosis no replay item can be built from, an unreadable skill, a
// lesson that does not validate, a write the perimeter refuses -- are thrown and not returned: the
// caller reports them, and none of them wrote a candidate.
export async function proposeSkill(
  request: ImproveRequest,
  ctx: ImproveFlowContext,
  deps: ImproveFlowDeps,
): Promise<ProposeFlowResult> {
  const seams = seamsOf(deps);
  // One clock for the whole run: the createdAt of the record, the staging timestamp, the lesson
  // date and the attempt line all name the same instant.
  const now = (deps.now ?? currentTime)();
  // One focus for the whole run: the record, the entry and the digest of the attempt all read this
  // value, so they cannot disagree about whether the run asked for anything.
  const focus = normalizeFocus(request.focus);

  const target = await resolveRunTarget(request.skillName, ctx, seams);
  if (target.kind === "unknown-skill") return target;

  const { skill, config } = target;
  const verdict = eligibilityOf(skill, config);
  if (!verdict.eligible) {
    const hashes = attemptHashes("not-eligible", skill.name, focus);
    await recordAttempt(seams, now, "not-eligible", skill, hashes);
    return {
      kind: "not-eligible",
      skill,
      reason: verdict.reason,
      entry: attemptEntry(request, skill, 0, "not-eligible", verdict.reason, hashes, null),
    };
  }

  const derived = sessionEvidence(ctx);

  if (derived === undefined) {
    const hashes = attemptHashes("no-evidence", skill.name, focus);
    await recordAttempt(seams, now, "no-evidence", skill, hashes);
    return {
      kind: "no-evidence",
      skill,
      entry: attemptEntry(request, skill, 0, "no-evidence", null, hashes, null),
    };
  }

  const propose = resolvePropose(seams, ctx);
  if (propose === undefined) {
    const hashes = attemptHashes("no-model", skill.name, focus);
    await recordAttempt(seams, now, "no-model", skill, hashes);
    return { kind: "no-model", skill };
  }

  const diagnosis = diagnoseEvidence(derived.items, derived.contextById, skill, ctx);
  const skillText = await seams.readSkillText(skill);

  const proposal = await propose({
    diagnosis,
    skill: { name: skill.name, description: skill.description, skillText },
    evidence: derived.items,
    now,
    ...(focus === undefined ? {} : { focus }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  if (!proposal.ok) {
    const refusedHashes = attemptHashes("error", skill.name, focus);
    return {
      kind: "refused",
      skill,
      reason: proposal.error.message,
      entry: attemptEntry(
        request,
        skill,
        derived.items.length,
        "error",
        proposal.error.message,
        refusedHashes,
        null,
      ),
    };
  }

  // The draft is serialized again instead of trusting the text the proposer returned: the two calls
  // are the same pure function over the same draft, so the bytes are identical, and the file that
  // reaches staging is produced from the draft the record also carries. A draft its own serializer
  // refuses never reaches the writer, which would refuse it too, one layer further from the reason.
  const lesson = serializeLesson(proposal.value.draft);
  if (!lesson.ok) {
    throw new ProposerError(`the lesson for ${quote(skill.name)} does not validate: ${lesson.error}`);
  }

  const draft = proposal.value.draft;
  // D4: the pair of hashes of the candidate, from the one function that computes it, so the record
  // built here carries the values the writer will stamp into the bytes it publishes.
  const hashes = candidateHashes(skill, lesson.value);
  const decision = buildDecision({
    now,
    request,
    skill,
    config,
    // The verdict this run calculated, and not an assumed one: the record says what admitted the
    // skill, so a record built under a false verdict cannot claim to be eligible.
    verdict,
    evidence: derived.items,
    diagnosis,
    draft,
    usage: proposal.value.usage,
    hashes,
  });

  const staged = await seams.write({
    root: seams.root,
    skill,
    slug: draft.slug,
    decision,
    now,
    lessonText: lesson.value,
  });

  // F1: the candidate and its index line are one unit. The line is attempted immediately, and a
  // failure retires the candidate instead of leaving a directory no line names -- a run that reports
  // "nothing was written" while a candidate sits in staging is the lie this catch prevents. The error
  // names both halves, including whether the removal worked (I8): a message that claimed a cleanup it
  // did not manage would be the same lie one layer down.
  try {
    await seams.appendAttempt(seams.root, {
      ts: now.toISOString(),
      event: "proposed",
      candidateHash: staged.contentHash,
      bodyHash: staged.bodyHash,
      targetSkill: skill.name,
      stagingPath: staged.stagingPath,
      decisionPath: staged.decisionPath,
    });
  } catch (error) {
    const removed = await discardCandidate(seams.root, staged.stagingPath);
    throw new SriWriterError(
      `wrote the candidate ${quote(staged.stagingPath)} but its attempt line failed (${toErrorMessage(error)}): the candidate was retired (removed: ${removed})`,
      staged.stagingPath,
    );
  }

  return {
    kind: "proposed",
    skill,
    evidence: derived.items,
    diagnosis,
    draft,
    usage: proposal.value.usage,
    staged,
    entry: attemptEntry(
      request,
      skill,
      derived.items.length,
      "proposed",
      null,
      { candidateHash: staged.contentHash, bodyHash: staged.bodyHash },
      { slug: draft.slug, stagingPath: staged.stagingPath, decisionPath: staged.decisionPath },
    ),
  };
}

// The seams with their production default, resolved once per call.
interface FlowSeams {
  readConfig: (settingsPath: string) => SriConfig;
  listSkills: (options: ListSkillsOptions) => Promise<SkillRef[]>;
  readSkillText: (skill: SkillRef) => Promise<string>;
  propose: ProposeFn | undefined;
  write: (input: StagingWriteInput) => Promise<StagingWriteResult>;
  appendAttempt: (root: string, line: AttemptLine) => Promise<void>;
  root: string;
  agentDir: string;
}

function seamsOf(deps: ImproveFlowDeps): FlowSeams {
  return {
    readConfig: deps.readConfig ?? readSriConfig,
    listSkills: deps.listSkills ?? listSkills,
    readSkillText: deps.readSkillText ?? readSkillFile,
    propose: deps.propose,
    write: deps.write ?? writeStagingCandidate,
    appendAttempt: deps.appendAttempt ?? appendAttemptLine,
    root: deps.root,
    // Resolved once per run and handed to both reads below, so a run cannot read the settings of one
    // agent directory and the skills of another.
    agentDir: deps.agentDir ?? getAgentDir(),
  };
}

async function readInventory(
  ctx: ImproveFlowContext,
  seams: FlowSeams,
): Promise<{ config: SriConfig; skills: SkillRef[] }> {
  const config = seams.readConfig(path.join(seams.agentDir, SETTINGS_FILE));
  const skills = await seams.listSkills({ cwd: ctx.cwd, agentDir: seams.agentDir });
  return { config, skills };
}

// The target of a run, or the refusal that says why there is none. The settings travel with it because
// both entries read them once, and the verdict of the skill is taken over that same file.
type RunTarget =
  | { kind: "resolved"; config: SriConfig; skill: SkillRef }
  | UnknownSkillFlowResult;

// Steps 1 and 2 of the run, the same in both entries: the settings and the inventory resolve the name,
// and a name they do not know comes back as the refusal itself -- the eligible set and the standalone
// the name could be -- so neither entry builds that answer a second time.
async function resolveRunTarget(
  skillName: string,
  ctx: ImproveFlowContext,
  seams: FlowSeams,
): Promise<RunTarget> {
  const { config, skills } = await readInventory(ctx, seams);
  const target = resolveTarget(skills, config, skillName);
  if (!target.ok) {
    return {
      kind: "unknown-skill",
      skillName,
      eligible: target.eligible,
      standalone: target.standalone,
    };
  }
  return { kind: "resolved", config, skill: target.skill };
}

// Step 3 of the run, also shared: the evidence of the session branch, or undefined when the session
// shows no failure. Zero items is absence and not an empty result -- a summary of zero failures would
// read like a diagnosis that found the skill healthy -- so the reading lives here and neither entry
// checks the count for itself.
function sessionEvidence(ctx: ImproveFlowContext): DerivedEvidence | undefined {
  const derived = deriveEvidence(messageEntries(ctx.sessionManager.getBranch()));
  return derived.items.length === 0 ? undefined : derived;
}

type TargetResolution =
  | { ok: true; skill: SkillRef }
  | { ok: false; eligible: readonly SkillRef[]; standalone: SkillRef | null };

function resolveTarget(
  skills: readonly SkillRef[],
  config: SriConfig,
  skillName: string,
): TargetResolution {
  // findSkill answers for declared skills only: a standalone .md has no directory of its own, so a
  // candidate for it would have no place to live. The answer still names the skill the inventory holds
  // under that name, so the refusal can say that it exists and why it is not a candidate (F6).
  const skill = findSkill(skills, skillName);
  if (skill === undefined) {
    return {
      ok: false,
      eligible: eligibleSkills(skills, config),
      standalone:
        skills.find((candidate) => candidate.kind === "standalone" && candidate.name === skillName) ?? null,
    };
  }
  return { ok: true, skill };
}

function eligibleSkills(skills: readonly SkillRef[], config: SriConfig): SkillRef[] {
  return skills.filter(
    (skill) => skill.kind === "declared" && eligibilityOf(skill, config).eligible,
  );
}

// A skill answers to two spellings -- the frontmatter `name` and the basename of its directory -- and
// findSkill resolves a request written either way, so the settings may name it with either one. The
// verdict is taken over both (F5), and the kind check above keeps the shared skills directory of a
// standalone skill out of the spellings that reach a write target.
function eligibilityOf(skill: SkillRef, config: SriConfig): Eligibility {
  return isEligibleUnderAnySpelling(spellingsOf(skill), config);
}

function spellingsOf(skill: SkillRef): string[] {
  const dirName = path.basename(skill.dir);
  return dirName === skill.name ? [skill.name] : [skill.name, dirName];
}

function diagnoseEvidence(
  items: readonly EvidenceItem[],
  contextById: ReadonlyMap<string, EvidenceContext>,
  skill: SkillRef,
  ctx: ImproveFlowContext,
): Diagnosis {
  const model = ctx.model;
  return buildDiagnosis(
    items,
    contextById,
    skill,
    ctx.cwd,
    model === undefined ? {} : { model: model.id },
  );
}

// The generation seam: the injected proposer if there is one, and otherwise one built around the
// single call the session model answers. Without a model there is nothing to build, and the caller
// reports that before anything is read from disk.
function resolvePropose(seams: FlowSeams, ctx: ImproveFlowContext): ProposeFn | undefined {
  const injected = seams.propose;
  if (injected !== undefined) return injected;

  const model = ctx.model;
  if (model === undefined) return undefined;

  // sessionId travels with every request, not only with the session's own turns: the registry
  // resolves credentials and forwards the options untouched, and the routing header of a
  // session-affine provider is built from this field alone.
  const complete: CompleteFn = (context, options) =>
    ctx.modelRegistry.complete(model, context, {
      ...options,
      sessionId: ctx.sessionManager.getSessionId(),
    });
  const proposer = createProposer(complete);
  return (input) => proposer.propose(input);
}

function attemptEntry(
  request: ImproveRequest,
  skill: SkillRef,
  evidenceCount: number,
  outcome: ImprovementOutcome,
  reason: string | null,
  hashes: AttemptHashes,
  staged: StagedCandidate | null,
): ImprovementEntry {
  return {
    surface: request.surface,
    skill: skill.name,
    focus: focusOrNull(request.focus),
    outcome,
    reason,
    evidenceCount,
    candidateHash: hashes.candidateHash,
    bodyHash: hashes.bodyHash,
    staged,
  };
}

// The internal representation of the focus is string | undefined, and a blank focus is no focus: the
// command collapses the words of its argument line and never sends one, and the tool's schema accepts
// "focus": "". Reading it here is what keeps the three artifacts of a run -- the trigger of the
// record, the session entry and the digest of the attempt -- naming the same request.
function normalizeFocus(focus: string | undefined): string | undefined {
  if (focus === undefined) return undefined;
  return focus.trim() === "" ? undefined : focus;
}

// The edge of the published shapes: DecisionTrigger and ImprovementEntry declare the focus as
// string | null, so the conversion happens here and in buildDecision and nowhere else.
function focusOrNull(focus: string | undefined): string | null {
  return normalizeFocus(focus) ?? null;
}

interface AttemptHashes {
  candidateHash: string;
  bodyHash: string;
}

// The name that identifies an attempt in its hashes: an event of the index, or -- for an attempt that
// produces no line -- the outcome its session entry records. The two vocabularies overlap on purpose;
// "error" exists only in the second one, because a generation that refused is not an event of the index.
type AttemptIdentity = AttemptLine["event"] | ImprovementOutcome;

// An event with no candidate and no body has nothing to tell apart, so both fields carry the digest
// of one documented identity of the attempt: the JSON array [event, skill, focus or ""]. They are
// equal on purpose -- it keeps the line the shape the index requires and groups the attempts that
// asked for the same thing on the same skill (D5). The focus is the one normalizeFocus answered, so
// the digest does not tell "no focus" from "focus empty": the run never carries the second one.
function attemptHashes(
  event: AttemptIdentity,
  skillName: string,
  focus: string | undefined,
): AttemptHashes {
  const digest = sha256Digest(JSON.stringify([event, skillName, focus ?? ""]));
  return { candidateHash: digest, bodyHash: digest };
}

// The index line of an attempt that produced no candidate: no evidence, a skill the settings exclude,
// no model to call. The line is the audit trail of a refusal that cost nothing, so "why did nothing
// happen" has an answer in state/attempts.jsonl and not only in the surface that reported it.
async function recordAttempt(
  seams: FlowSeams,
  now: Date,
  event: AttemptLine["event"],
  skill: SkillRef,
  hashes: AttemptHashes,
): Promise<void> {
  await seams.appendAttempt(seams.root, {
    ts: now.toISOString(),
    event,
    candidateHash: hashes.candidateHash,
    bodyHash: hashes.bodyHash,
    targetSkill: skill.name,
  });
}

// The compensation of F1. The removal can itself fail -- a permission on the directory, a path the
// perimeter refuses -- and the error the caller is about to raise already names the failed index, so
// this function only answers what happened to the directory and never replaces the reason.
async function discardCandidate(root: string, stagingPath: string): Promise<boolean> {
  try {
    return await discardStagingCandidate(root, stagingPath);
  } catch {
    return false;
  }
}

// The record that lands next to the lesson. The two hashes come from src/writer.ts (D4) and are
// computed once, from the lesson text: buildDecision stamps the same pair the writer will stamp into
// the bytes it publishes, so an in-memory record and the decision.json it becomes cannot disagree.
//
// Exported because a run never builds a record under an ineligible verdict -- it refuses first, and
// nothing is written -- so the only way to prove the skill block follows the verdict instead of
// assuming it is to build one by hand, the same reason runSkillImproveTool is exported.
export interface DecisionInput {
  now: Date;
  request: ImproveRequest;
  skill: SkillRef;
  config: SriConfig;
  verdict: Eligibility;
  evidence: readonly EvidenceItem[];
  diagnosis: Diagnosis;
  draft: LessonDraft;
  usage: GenerationUsage;
  hashes: LessonHashes;
}

export function buildDecision(input: DecisionInput): DecisionRecord {
  const { skill, draft } = input;

  return {
    schema: "pi-simple-sri/decision@0",
    createdAt: input.now.toISOString(),
    trigger: { surface: input.request.surface, focus: focusOrNull(input.request.focus) },
    skill: toDecisionSkill(skill, input.verdict.eligible),
    eligibility: { allow: [...input.config.allow], deny: [...input.config.deny] },
    evidence: [...input.evidence],
    diagnosis: input.diagnosis,
    candidate: {
      kind: "new-lesson",
      slug: draft.slug,
      title: draft.title,
      targetLesson: null,
      // The path of the lesson has one owner (src/skill-reference.ts): the same path the reference
      // line of SKILL.md names, so the record and the acceptance cannot point at two files.
      lessonPath: lessonReferencePath(draft.slug),
      contentHash: input.hashes.contentHash,
      bodyHash: input.hashes.bodyHash,
    },
    // M0 never runs the gate, so every result field is null (schema 0). The tokens of the single
    // generation are the one number the block can carry: they were spent to produce this candidate
    // and Q6 wants them recorded per decision.
    gate: {
      status: "not-run",
      threshold: null,
      reps: null,
      budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
      tokens: { input: input.usage.input, output: input.usage.output },
      mde: null,
    },
    outcome: { status: "proposed", reason: null },
  };
}

// D4: the pair of hashes of the candidate, from the one function that computes it (src/writer.ts).
// The input is the lesson text this module serialized, so the pair the record carries is the pair the
// writer stamps into the bytes it publishes. A text its own parser refuses never reaches the writer,
// which would refuse it too, one layer further from the skill it was written for.
function candidateHashes(skill: SkillRef, lessonText: string): LessonHashes {
  const hashes = lessonHashes(lessonText);
  if (!hashes.ok) {
    throw new ProposerError(`the lesson for ${quote(skill.name)} does not validate: ${hashes.error}`);
  }
  return hashes.value;
}

function currentTime(): Date {
  return new Date();
}

// deriveEvidence walks message entries; the branch also carries model changes, labels, compaction
// records and the entries this package appends, and none of them is a message.
function messageEntries(branch: readonly SessionEntry[]): SessionMessageEntry[] {
  const messages: SessionMessageEntry[] = [];
  for (const entry of branch) {
    if (entry.type === "message") messages.push(entry);
  }
  return messages;
}

async function readSkillFile(skill: SkillRef): Promise<string> {
  const skillPath = path.join(skill.realDir, SKILL_FILE);
  try {
    return await fs.promises.readFile(skillPath, "utf8");
  } catch (error) {
    // The original error travels as the cause, as src/skills-inventory.ts does: the message is the
    // reason the caller reports, and the cause keeps the code and the stack of the failure.
    throw new SriFailClosedError(
      `cannot read ${quote(skillPath)} for skill ${quote(skill.name)}: ${toErrorMessage(error)}`,
      { cause: error },
    );
  }
}
