import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { attemptHashes, buildAttemptLine, type AttemptEvent, type AttemptHashes } from "./attempts.ts";
import { caseBankReason, loadCaseBank, type CaseBank } from "./case-bank.ts";
import { readSriConfig } from "./config.ts";
import { buildBaselineDiagnosis, buildDefectDiagnosis, buildDiagnosis } from "./diagnosis.ts";
import { isEligibleUnderAnySpelling } from "./eligibility.ts";
import { deriveEvidence, modelIdentity, type DerivedEvidence, type EvidenceContext } from "./evidence.ts";
import { ProposerError, SriFailClosedError, SriWriterError } from "./errors.ts";
import { notConcludedGateOf } from "./gate/flow.ts";
import { sha256Digest, sha256Hex } from "./hash.ts";
import { serializeLesson } from "./lesson-frontmatter.ts";
import { createModelCall, type ModelCallRegistry } from "./model-call.ts";
import { SKILL_FILE } from "./names.ts";
import { createProposer, type GenerationUsage, type ProposeInput, type ProposeResult } from "./proposer.ts";
import { lessonReferencePath } from "./skill-reference.ts";
import { findSkill, listSkills, type ListSkillsOptions } from "./skills-inventory.ts";
import { outcomeStatusFor, toDecisionSkill } from "./types.ts";
import type {
  AttemptLine,
  DecisionRecord,
  DecisionSurface,
  DecisionTrigger,
  Diagnosis,
  Eligibility,
  EvidenceItem,
  GateBasis,
  GateBlock,
  GateTokenTally,
  LessonDraft,
  NotEligibleReason,
  Result,
  SkillRef,
  SriConfig,
} from "./types.ts";
import { currentTime, quote, readBytes, toErrorMessage } from "./values.ts";
import { assertBaseOutsideSkill, relativeToBase, writeBase } from "./write-base.ts";
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
//   2. a skill the settings exclude is refused before the model is called, and so is the skill whose name this package
//      reserves -- that rule reads no list and no setting can change it (src/eligibility.ts) -- and the refusal is
//      recorded with its reason, so an ineligible skill never spends a generation (Q17, D6);
//   3. the evidence comes from the session branch alone; with none there is no candidate, and the
//      attempt is recorded anyway so "nothing happened" is auditable (D5). A run that names a case
//      bank asks for a direction instead (M1c): its failures are the cases the bank declares, so this
//      step does not apply to it, the diagnosis is the ask itself, and the record says the gate of the
//      bank will measure the candidate. A run that also names a defect reads the artifact the bank
//      declares (M1c, S8): its evidence is one item of the fourth class, the cases of the bank are what
//      the replay measures, and a bank or an artifact that cannot be read is the same refusal of this
//      step, with the problem in the reason;
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
// The clock, the settings file, the inventory, the model, the writer, the record channels and the
// write base are all resolved inside the two entry points, so the wiring passes no path of its own.

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

// The staged candidate, when the run produced one. Both paths are relative to the base of the run
// (writeBase): a record stays readable after the agent directory moves, and no machine-specific path
// enters the index, the session entry or an answer. The absolute spellings stay inside the flow, which
// needs them to retire a candidate whose index line failed.
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
  // Why, in the vocabulary of the verdict when the cause is the eligibility -- a NotEligibleReason: the settings, or the
  // name this package reserves --, the proposer's message when the generation refused, and null when a candidate was staged.
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

// The one model call this package makes, typed exactly after the registry method it forwards to: a ModelRegistry
// satisfies this interface without a conversion, and a test fake only has to provide one method. The contract moved
// to src/model-call.ts with the construction that consumes it -- the judge of the gate is its second caller -- and the
// name stays exported here for the callers that already import it.
export type ImproveFlowModelRegistry = ModelCallRegistry;

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
// `base` is where the run writes: staging/ and state/ live under it, and every path a record or an
// answer carries is relative to it. It defaults to writeBase(agentDir), so the anchor follows pi's own
// agent directory (getAgentDir, overridable with PI_CODING_AGENT_DIR) instead of the package root,
// which under `pi install npm:pi-simple-sri` is a directory inside node_modules that an upgrade takes
// away. It stays a seam because a test proves where the bytes went without touching a real agent
// directory.
export interface ImproveFlowDeps {
  base?: string;
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
  appendAttempt?: (base: string, line: AttemptLine) => Promise<void>;
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
  // Where the case bank of this run is, when the run has one (M1c): a request that names a bank asks for a directional
  // improvement, so the run proposes from the ask instead of from the transcript and its record says the bank will
  // measure it. Absent is the run of M1, unchanged -- the evidence of the session and a gate of the replayed turns --
  // and the path itself is read by the gate and not here: a bank that does not exist is a missing baseline, which is a
  // state of the attempt and not a reason to refuse the proposal (OA9).
  bankPath?: string;
  // Whether the bank describes the artifact a defect came from instead of the cases to measure (M1c). The branch that
  // reads it is the defect branch (S8); this flow only knows what it means for the base, and a defect is measured by
  // the replay flow (OA11), so such a request is not the base of the bank.
  defect?: boolean;
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
  // The verdict as the rule returned it: the sentence that reports it is src/messages.ts's, and it dispatches
  // over the two reasons, so the flow carries the reason itself and not a wider string.
  reason: NotEligibleReason;
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
  // The base every relative path of this result is named against. It travels with the answer because a
  // relative path alone cannot be opened: the human answer renders it absolute and `details` hands the
  // base to whoever consumes the machine fields.
  base: string;
  staged: StagedCandidate;
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

  // The base of a run stays outside the skill it improves: candidates inside the skill would make
  // staging a part of it, and the audit index would land next to its SKILL.md. Checked before any
  // branch that writes, because every line of the index and every candidate lands under the base.
  assertBaseOutsideSkill(seams.base, [skill.dir, skill.realDir]);

  const verdict = eligibilityOf(skill, config);
  if (!verdict.eligible) {
    const hashes = attemptHashes("not-eligible", skill.name, focus);
    // The reason the entry below carries: one value for the index and for /tree, so the two cannot report two causes.
    await recordAttempt(seams, now, "not-eligible", skill, hashes, verdict.reason);
    return {
      kind: "not-eligible",
      skill,
      reason: verdict.reason,
      entry: attemptEntry(request, skill, 0, "not-eligible", verdict.reason, hashes, null),
    };
  }

  // The third branch of the run (M1c, S8): a request whose bank describes the artifact a defect came from reads that
  // artifact instead of the transcript. Its evidence is one item of the fourth class, the cases of the bank are what the
  // gate of M1 replays (OA11), and every material that cannot be read is the `no-evidence` refusal that already exists --
  // with the problem in the reason of the entry and in its line of the index -- so a bank that is not there, a bank of the
  // other profile and an artifact that is not there are states of the attempt and not events nobody has named yet.
  const defect = request.defect === true ? await defectMaterialsOf(request, skill, ctx, now) : undefined;
  if (defect !== undefined && !defect.ok) {
    const hashes = attemptHashes("no-evidence", skill.name, focus);
    // The problem of the material, which is the reason of the entry below: what the bank or the artifact failed at is
    // also what the line of the index keeps.
    await recordAttempt(seams, now, "no-evidence", skill, hashes, defect.error);
    return {
      kind: "no-evidence",
      skill,
      entry: attemptEntry(request, skill, 0, "no-evidence", defect.error, hashes, null),
    };
  }
  const materials = defect !== undefined && defect.ok ? defect.value : undefined;

  // Where the failures of this run are written down is a property of its base (M1c): a request that names a bank asks
  // for a direction and the bank is what measures it, so the transcript is not read at all -- a session with no
  // failure is not a refusal in this base -- while a request that names none is the run of M1, unchanged. The branch of
  // the defect reads neither: its evidence is the artifact above, so the session is not read for it either.
  const basis = basisOf(request);
  const derived = basis === "replay" && materials === undefined ? sessionEvidence(ctx) : undefined;

  // Zero items is absence and not an empty result, and it is the refusal of the base that reads the transcript: a
  // summary of nothing would read like a diagnosis that found the skill healthy.
  if (basis === "replay" && materials === undefined && derived === undefined) {
    const hashes = attemptHashes("no-evidence", skill.name, focus);
    // No reason to pass, and that is the datum and not an omission: the entry of this branch carries null, because
    // the absence of a failure is the whole answer.
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
    // Also without a reason: there is no entry of this branch to take one from, and the line does not invent one.
    await recordAttempt(seams, now, "no-model", skill, hashes);
    return { kind: "no-model", skill };
  }

  // What the generation is written from, per branch: the evidence the transcript gave and the diagnosis built from it, the
  // ask alone -- no evidence item and no replayed turn, because the turns a directional attempt replays are the cases of
  // the bank, which the gate reads when it runs and this run has not read yet --, or the artifact of a defect and the cases
  // of its bank. The three are exclusive by construction: `materials` is undefined in the first two and `derived` in the
  // last one.
  let evidence: readonly EvidenceItem[];
  let diagnosis: Diagnosis;
  if (materials !== undefined) {
    evidence = [materials.evidence];
    diagnosis = buildDefectDiagnosis(materials.evidence, materials.bank, skill, ctx.cwd, sessionModelOf(ctx));
  } else if (derived === undefined) {
    evidence = [];
    diagnosis = buildBaselineDiagnosis(triggerOf(request), skill);
  } else {
    evidence = derived.items;
    diagnosis = diagnoseEvidence(derived.items, derived.contextById, skill, ctx);
  }
  const skillText = await seams.readSkillText(skill);

  const proposal = await propose({
    diagnosis,
    skill: { name: skill.name, description: skill.description, skillText },
    evidence,
    basis,
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
        evidence.length,
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
    evidence,
    diagnosis,
    draft,
    usage: proposal.value.usage,
    hashes,
  });

  const staged = await seams.write({
    base: seams.base,
    skill,
    slug: draft.slug,
    decision,
    now,
    lessonText: lesson.value,
  });

  // The record, the index line and both answers name the candidate relative to the base of the run, so
  // a record stays readable after the agent directory moves and no machine path is baked into it. The
  // absolute spellings stay local: they are what the removal below needs.
  const stagingPath = relativeToBase(seams.base, staged.stagingPath);
  const decisionPath = relativeToBase(seams.base, staged.decisionPath);
  // One value for the result and the entry: two literals of the same three fields can drift apart, and
  // the session entry and the answer would then describe two different candidates.
  const candidate: StagedCandidate = { slug: draft.slug, stagingPath, decisionPath };

  // F1: the candidate and its index line are one unit. The line is attempted immediately, and a
  // failure retires the candidate instead of leaving a directory no line names -- a run that reports
  // "nothing was written" while a candidate sits in staging is the lie this catch prevents. The error
  // names both halves, including whether the removal worked (I8): a message that claimed a cleanup it
  // did not manage would be the same lie one layer down.
  try {
    await seams.appendAttempt(
      seams.base,
      buildAttemptLine({
        now,
        event: "proposed",
        targetSkill: skill.name,
        // The pair the writer published, not a second computation of it: the record, the entry and the
        // line name the same bytes.
        hashes: { candidateHash: staged.contentHash, bodyHash: staged.bodyHash },
        // The failure a candidate is about, taken from the diagnosis the record carries (OA4): a reader
        // of the index can group every candidate written for the same failure without opening
        // decision.json.
        failureSignature: diagnosis.failureSignature,
        stagingPath,
        decisionPath,
      }),
    );
  } catch (error) {
    const removed = await discardCandidate(seams.base, staged.stagingPath);
    throw new SriWriterError(
      `wrote the candidate ${quote(stagingPath)} but its attempt line failed (${toErrorMessage(error)}): the candidate was retired (removed: ${removed})`,
      staged.stagingPath,
    );
  }

  return {
    kind: "proposed",
    skill,
    evidence,
    diagnosis,
    draft,
    usage: proposal.value.usage,
    base: seams.base,
    staged: candidate,
    entry: attemptEntry(
      request,
      skill,
      evidence.length,
      "proposed",
      null,
      { candidateHash: staged.contentHash, bodyHash: staged.bodyHash },
      candidate,
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
  appendAttempt: (base: string, line: AttemptLine) => Promise<void>;
  base: string;
  agentDir: string;
}

function seamsOf(deps: ImproveFlowDeps): FlowSeams {
  // Resolved once per run and handed to the reads below and to the base, so a run cannot read the
  // settings of one agent directory, the skills of another and write into a third place.
  const agentDir = deps.agentDir ?? getAgentDir();
  return {
    readConfig: deps.readConfig ?? readSriConfig,
    listSkills: deps.listSkills ?? listSkills,
    readSkillText: deps.readSkillText ?? readSkillFile,
    propose: deps.propose,
    write: deps.write ?? writeStagingCandidate,
    appendAttempt: deps.appendAttempt ?? appendAttemptLine,
    base: deps.base ?? writeBase(agentDir),
    agentDir,
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
// checks the count for itself. The base of the case bank never comes here (M1c): its failures are the cases
// the bank declares, and the transcript is not what it measures.
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

// OA5: the identity of the model of the invocation, in the "provider/model" spelling the evidence carries, so a replay item
// never mixes one form with the other; the bare id is ambiguous between providers that serve it. The spelling itself
// belongs to src/evidence.ts (modelIdentity), the module that owns it.
//
// It is the fallback of the base of the transcript -- the model of the failing turn wins (src/diagnosis.ts) -- and the only
// answer for the branch of the defect, which has no turn of the session to name one.
function sessionModelOf(ctx: ImproveFlowContext): string | undefined {
  const model = ctx.model;
  return model === undefined ? undefined : modelIdentity(model.provider, model.id);
}

function diagnoseEvidence(
  items: readonly EvidenceItem[],
  contextById: ReadonlyMap<string, EvidenceContext>,
  skill: SkillRef,
  ctx: ImproveFlowContext,
): Diagnosis {
  const model = sessionModelOf(ctx);
  return buildDiagnosis(items, contextById, skill, ctx.cwd, model === undefined ? {} : { model });
}

// The materials of the branch of the defect (M1c, S8): the bank of profile `origin` and the artifact it names, read and
// hashed. The two travel together because neither is a diagnosis on its own -- the evidence is the truth and the bank the
// cases that measure it -- and both are read before the generation, so a run that cannot measure refuses before spending.
interface DefectMaterials {
  evidence: EvidenceItem;
  bank: CaseBank;
}

// The materials of the branch of the defect, or the problem that stops the run before it spends a generation.
//
// The three steps are the three reasons a run that cannot measure refuses:
//
//   1. the request names a bank: a defect with no bank has no case to replay, and nothing else in the request says where
//      the cases that measure it are written down;
//   2. the bank is a bank of profile `origin`, read by the one reader of the format (src/case-bank.ts) -- absent,
//      unreadable, of another version, of the profile of a directional bank or with a case that does not validate are all
//      refusals of that reader, and its reason travels as it is (caseBankReason);
//   3. the artifact the origin names is a file this run can read, and the digest of its bytes is what the evidence keeps,
//      so the gate can re-read the same bytes before it spends a run (src/gate/flow.ts, origin-moved).
//
// Nothing here compares a digest with another one: the bank declares the artifact and not its hash, so the only comparison
// that exists is the one the gate makes against the record.
//
// The path of the artifact is resolved against the cwd of the invocation, and the resolved path is what the record keeps,
// so the gate re-reads the same file from wherever it runs. A relative path in the bank is therefore relative to the
// directory the run was asked from -- the one directory the proposal and the gate share.
async function defectMaterialsOf(
  request: ImproveRequest,
  skill: SkillRef,
  ctx: ImproveFlowContext,
  now: Date,
): Promise<Result<DefectMaterials, string>> {
  const bankPath = request.bankPath;
  if (bankPath === undefined) {
    return {
      ok: false,
      error: `bank-absent: a defect of skill ${quote(skill.name)} needs a bank, and the request names none`,
    };
  }

  const bank = await loadCaseBank(bankPath, "origin");
  if (!bank.ok) return { ok: false, error: caseBankReason(bank.error) };

  const origin = bank.value.origin;
  if (origin === undefined) {
    // Unreachable through the reader, which refuses a bank of this profile without an origin. The field is optional in the
    // contract, so the branch is written instead of assumed away: a defect with no artifact has nothing to name.
    return { ok: false, error: `bank-invalid: the bank ${quote(bankPath)} declares no origin` };
  }

  const artifactPath = path.resolve(ctx.cwd, origin.path);
  const bytes = await readArtifact(artifactPath);
  if (!bytes.ok) return bytes;

  const contentHash = sha256Digest(bytes.value);
  return {
    ok: true,
    value: {
      bank: bank.value,
      evidence: {
        // The artifact and its bytes name the failure, the way the transcript names one (src/evidence.ts): two runs over the
        // same defect agree, which is what makes their lines group on the failure signature of the diagnosis, and an
        // artifact that moved is another item.
        id: `ev-${sha256Hex(JSON.stringify(["quality_defect", origin.kind, artifactPath, contentHash])).slice(0, 8)}`,
        kind: "quality_defect",
        timestamp: now.getTime(),
        // A defect is read from a file and not from a turn: the value `persisted` already had.
        source: "persisted",
        excerpt: origin.excerpt,
        origin: { kind: origin.kind, path: artifactPath, contentHash },
      },
    },
  };
}

// The artifact of a defect, read as bytes: the digest of the bytes and not of a re-serialization of them is what the
// evidence records, so a file that differs in whitespace is a file that moved. Absence is a refusal with its own word and
// not an exception, the reading src/values.ts gives a read and src/case-bank.ts gives a bank that is not there; the two
// words of that reading become the two of this flow.
async function readArtifact(artifactPath: string): Promise<Result<Buffer, string>> {
  const read = await readBytes(artifactPath);
  if (read.ok) return read;

  const word = read.error.error === "absent" ? "artifact-absent" : "artifact-unreadable";
  return { ok: false, error: `${word}: ${read.error.detail}` };
}

// The generation seam: the injected proposer if there is one, and otherwise one built around the
// single call the session model answers. Without a model there is nothing to build, and the caller
// reports that before anything is read from disk.
function resolvePropose(seams: FlowSeams, ctx: ImproveFlowContext): ProposeFn | undefined {
  const injected = seams.propose;
  if (injected !== undefined) return injected;

  const model = ctx.model;
  if (model === undefined) return undefined;

  // The construction is the one every model call of this package shares (src/model-call.ts): it bounds the call with
  // the proposer's budget and puts the identifier of the session on every request, so the judge of the gate cannot
  // wire either of them differently.
  const proposer = createProposer(
    createModelCall({ registry: ctx.modelRegistry, model, sessionId: ctx.sessionManager.getSessionId() }),
  );
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
// string | null, so the conversion happens here -- and through triggerOf, which is the one caller that builds the
// published trigger -- and nowhere else.
function focusOrNull(focus: string | undefined): string | null {
  return normalizeFocus(focus) ?? null;
}

// The trigger of the record, in the published spelling. It has one owner because two artifacts are derived from it and
// not one: the trigger block of decision.json and the diagnosis of a directional attempt, which summarizes the ask
// (src/diagnosis.ts, buildBaselineDiagnosis). Two spellings would let the record and its own summary describe two
// different requests.
function triggerOf(request: ImproveRequest): DecisionTrigger {
  return { surface: request.surface, focus: focusOrNull(request.focus) };
}

// Which base measures the candidate of this run (M1c). A request that names a bank asks for a directional improvement
// and the bank is where its failures are written down; everything else -- including a request that names no bank at
// all, which is the only shape M1 wrote -- is the base of the replayed turns. The defect branch reuses that base
// (OA11), so a bank of the origin profile is not the base of the bank and its branch reads this value as replay.
function basisOf(request: ImproveRequest): GateBasis {
  return request.bankPath !== undefined && request.defect !== true ? "case-bank" : "replay";
}

// The gate block of a candidate that was proposed and not gated yet: no preregistration and no result, because neither is
// invented by a run that has not gated anything, and the whole block is the one src/gate/flow.ts writes for any gate that
// has not concluded -- the two bases and the two states of a gate before its runs are one constructor, not four literals.
function proposedGateOf(basis: GateBasis, usage: GenerationUsage): GateBlock {
  const tokens: GateTokenTally = {
    proposal: { input: usage.input, output: usage.output },
    incumbent: { input: 0, output: 0 },
    candidate: { input: 0, output: 0 },
    total: { input: usage.input, output: usage.output },
  };

  return notConcludedGateOf(basis, tokens, 0, null);
}

// The index line of an attempt that produced no candidate: no evidence, a skill the settings exclude,
// no model to call. The line is the audit trail of a refusal that cost nothing, so "why did nothing
// happen" has an answer in state/attempts.jsonl and not only in the surface that reported it.
//
// Its failureSignature is null on purpose (OA4): none of these refusals reached a diagnosis, so there is no
// failure to name, and the field says exactly that instead of being absent.
//
// The reason travels when the entry of the same branch carries one, and the field is left out when it does not: the
// two causes of a `not-eligible` -- the settings and the manual this package publishes -- are answers a reader of the
// index has to tell apart without the session, and a refusal whose cause is the absence itself has no word to keep.
// The omission is the one src/attempts.ts already makes for an absent reason, the same one the line of a gate that
// answered without a reason relies on (src/gate/flow.ts, lineReasonOf).
async function recordAttempt(
  seams: FlowSeams,
  now: Date,
  event: AttemptEvent,
  skill: SkillRef,
  hashes: AttemptHashes,
  reason?: string,
): Promise<void> {
  await seams.appendAttempt(
    seams.base,
    buildAttemptLine({
      now,
      event,
      targetSkill: skill.name,
      hashes,
      failureSignature: null,
      ...(reason === undefined ? {} : { reason }),
    }),
  );
}

// The compensation of F1. The removal can itself fail -- a permission on the directory, a path the
// perimeter refuses -- and the error the caller is about to raise already names the failed index, so
// this function only answers what happened to the directory and never replaces the reason.
async function discardCandidate(base: string, stagingPath: string): Promise<boolean> {
  try {
    return await discardStagingCandidate(base, stagingPath);
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
    schema: "pi-simple-sri/decision@1",
    createdAt: input.now.toISOString(),
    trigger: triggerOf(input.request),
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
    // The gate has not run: `basis` names how it would decide -- and it is the base of the run, read from the request
    // and not passed in, so no caller can stamp a block that names a base its own request does not (M1c) --, the
    // preregistration and the result are absent, and neither the budget nor a verdict is invented. The tokens of the
    // single generation are the one number the block can carry -- they were spent to produce this candidate and Q6
    // wants them recorded per decision -- and `total` is the sum of the components, which today is the proposal alone
    // because no run of the gate has happened yet.
    gate: proposedGateOf(basisOf(input.request), input.usage),
    // The outcome is the one its gate status implies, through the single mapping that relates the two fields
    // (outcomeStatusFor): a gate that has not run has decided nothing, so the record says the candidate was
    // proposed and no moment decided it.
    outcome: { status: outcomeStatusFor("not-run"), reason: null, decidedAt: null },
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
