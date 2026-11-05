import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSriConfig } from "./config.ts";
import { isEligibleUnderAnySpelling, spellingsOfSkill } from "./eligibility.ts";
import { SriFailClosedError, SriWriterError } from "./errors.ts";
import { acceptCandidate, type AcceptDeps } from "./gate/acceptance.ts";
import {
  gateDirectionalCandidate,
  type DirectionalGateResult,
} from "./gate/directional-flow.ts";
import {
  gateStagedCandidate,
  resolveStagedCandidate,
  verifiedStagedLesson,
  type GateConcludedResult,
  type GateDeps,
  type GateFlowResult,
} from "./gate/flow.ts";
import {
  ENTRY_TYPE,
  listEligibleSkills,
  proposeSkill,
  type ImproveFlowContext,
  type ImproveFlowDeps,
  type ImproveFlowModelRegistry,
  type ImprovementEntry,
  type ProposeFn,
} from "./improve-flow.ts";
import { readLedger, type Ledger } from "./ledger.ts";
import {
  acceptedText,
  damagedIndexText,
  gateAbstainedText,
  gatePassedText,
  gateRejectedText,
  listedNames,
  metricsText,
  noBaselineText,
  noEvidenceText,
  noModelGateText,
  noModelText,
  notEligibleText,
  proposedText,
  refusedText,
  reloadFailedText,
  retiredText,
  retireRejectedText,
  retirementReloadFailedText,
  standingText,
  unknownSignalText,
  unknownSkillText,
} from "./messages.ts";
import { metricsOf } from "./metrics.ts";
import { wireDirectionalGate } from "./model-call.ts";
import { ATTEMPTS_FILE, COMMAND_NAME, SETTINGS_FILE, SKILL_IMPROVE_TOOL_NAME } from "./names.ts";
import { RETIREMENT_REASONS, retireLesson, type RetireDeps, type RetirementReason } from "./retirement.ts";
import { findSkill, listSkills } from "./skills-inventory.ts";
import type { SignalCollector, Suspicion } from "./signals.ts";
import { standingOf } from "./standing.ts";
import { assertNever, type DecisionRecord, type DecisionSurface, type Eligibility, type SkillRef } from "./types.ts";
import { quote, toErrorMessage } from "./values.ts";
import { writeBase, stateDir } from "./write-base.ts";

// The /skill-improve command: one run of the loop over one named skill (P8), and from M1 the one surface of
// the package that may edit a skill.
//
// The loop itself -- settings, inventory, eligibility, evidence, diagnosis, one generation, the
// staging write and the index line -- lives in src/improve-flow.ts, because the skill_improve tool
// runs the same pipeline (P9) and two copies of it would drift. The gate lives in src/gate/flow.ts -- and, for the base of
// the bank, in src/gate/directional-flow.ts -- and the acceptance in src/gate/acceptance.ts for the same reason: the tool runs
// the first, and what stays here is what only a user command does -- parse the arguments, report every outcome as a
// notification, record the session entry with its degradation warning, and answer through another channel when there is no UI.
//
// The sentences it reports are src/messages.ts, shared with the tool: the two surfaces say the same
// things about the same outcomes, and a surface that no longer matched the other was a bug nobody
// could see.
//
// The difference between the two surfaces is explicit and small: the command reports, and it is the one that
// accepts (M1, M2). It accepts exactly where the gate says it may -- the chain is propose, gate, accept, and
// the third step runs only on a `gate-accepted` -- so the tool can gate a candidate of the same skill and the
// skill stays untouched until the command runs.
//
// The command never touches a skill before an acceptance: every path taken here writes inside
// <package>/staging and <package>/state through the flow, and a skill is edited by exactly two steps, both of them this
// surface's own: the acceptance of M1 -- guarded by the eligibility verdict that travels to it as data (M3, S7), the
// snapshot, the drift check and the reference line of src/gate/acceptance.ts -- and the retirement of M3 (S4), which takes
// an accepted lesson back out of use with the protocol of src/retirement.ts. The tool has neither.
//
// M1c adds two branches and no second writer. A run that names a case bank (--bank=<path>) is measured by the flow of
// src/gate/directional-flow.ts instead of by the replayed turns of the session, and the bank without --defect is the whole
// dispatch: --defect names a bank too -- it is the file the artifact and the cases are declared in, and the proposal reads it
// -- but a defect is measured by the replay base (OA11), so the flag takes the run out of the bank's gate and not out of its
// bank. A run with --staged=<stagingPath> skips the proposal and gates a candidate that already exists, so the acceptance has
// no draft to serialize: it reads the lesson the candidate holds and verifies it against the hashes its record declares, which
// is the guard both gate bases run before they spend a run. Both branches accept exactly where the gate accepts, which is the
// whole rule of this surface.
//
// Importing this module reads nothing, registers nothing and starts nothing (rule 9 of the slice).
// The clock, the settings file, the inventory, the model, the writer, the gate, the acceptance and the record
// channels are all resolved inside runSkillImprove, which is the only entry point.

// The surface this module reports for, in the vocabulary of decision.json (src/types.ts): the same
// value it hands proposeSkill as the trigger of the record, and the one the shared sentences use to
// pick the wording of a surface that knows the attempt was recorded.
const SURFACE: DecisionSurface = "command";

// The session entry type and the entry it carries belong to the loop, so both surfaces record the
// same shape. They are re-exported here because this module was their first home and the callers
// that read them -- the wiring and the tests -- import them from the command.
export { ENTRY_TYPE };
export type { ImprovementEntry, ProposeFn };
export type SkillImproveModelRegistry = ImproveFlowModelRegistry;

export type NotifyType = "info" | "warning" | "error";

export type NotifyFn = (message: string, type: NotifyType) => void;

export interface SkillImproveUi {
  notify(message: string, type?: NotifyType): void;
}

export interface SkillImproveMessage {
  customType: string;
  content: string;
  display: boolean;
}

// The part of the command context this command uses, spelled out instead of taking the whole
// ExtensionCommandContext: a fake in the tests then costs eight fields, and a change in pi's context
// that breaks this contract fails to compile where the wiring passes the real context.
//
// It carries no appendEntry and no sendMessage: both live on the extension API
// (ExtensionAPI.appendEntry, ExtensionAPI.sendMessage) and pi's command context has neither, so both
// channels are seams of SkillImproveDeps and the wiring is the one that connects them.
//
// waitForIdle and reload are members here and not seams of SkillImproveDeps, for the opposite reason: pi
// exposes both on the context of a command and not on the context of a tool (ExtensionCommandContext, in
// dist/core/extensions/types.d.ts:290 and :322), and this context is already the thing the tests replace
// with a fake -- a seam would be a second place to say what the context already says (M2).
//
// Both are required and not optional with a no-op: a fake that forgets them has to break the compiler.
// Optional members would let a context without them satisfy this interface, and the reload of the session
// would then be lost in silence -- which is exactly the defect M2 closes.
//
// The four members the loop reads come from ImproveFlowContext, so this context is a superset of it
// and reaches proposeSkill without a conversion.
export interface SkillImproveContext extends ImproveFlowContext {
  readonly hasUI: boolean;
  readonly ui: SkillImproveUi;
  // Step 8 of a run that accepted a candidate (M2): the session waits for the agent to go idle and then reloads
  // itself, so the skill the acceptance just wrote is read again here instead of at the next session start.
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
}

// Every dependency the command touches: the seams of the loop, the two steps M1 chains after it, plus the two
// report channels and the entry channel. Each one is optional -- the loop, the gate and the acceptance resolve
// what they are not given -- and a test replaces what it needs.
//
// `notify` replaces the whole report of the run, which is what a test that only counts notifications
// wants. `sendMessage` is the channel the wiring connects: without a UI the runner hands the handler a
// no-op ui context, so the result has to leave through the session, and only the extension API can put
// it there. It is a seam and not a member of the context because pi's command context carries no
// message channel, and a wrapper that copied the context to add one would freeze the getters pi builds
// it with (dist/core/extensions/runner.js:724-728).
export interface SkillImproveDeps extends ImproveFlowDeps {
  appendEntry?: (customType: string, data: ImprovementEntry) => void;
  notify?: NotifyFn;
  sendMessage?: (message: SkillImproveMessage) => void;
  // The two steps M1 chains after the loop, each one a seam for the same reason the loop's own are: a test
  // proves the order of the chain without spending a replay or editing a skill. `gateDeps` and `acceptDeps`
  // are the seams of those steps, passed through untouched, so a test can also keep the real gate or the real
  // acceptance and replace one read or one write inside it.
  //
  // `gateDirectional` is the second flow of M1c, and it is a second seam because it is a second flow: the base of the bank
  // resolves no inventory and spends a judge, so a test that drives the chain of that base cannot be a request of the other
  // one. The judge it needs is built from the session by the one wiring of src/model-call.ts and is not a seam of its own --
  // the flow requires it, so a test that wants a verdict replaces the whole flow instead of the call inside it.
  gate?: typeof gateStagedCandidate;
  gateDirectional?: typeof gateDirectionalCandidate;
  gateDeps?: GateDeps;
  accept?: typeof acceptCandidate;
  acceptDeps?: AcceptDeps;
  // The retirement of a lesson (M3, S4), the second step of this surface that writes into a skill and the only one that
  // takes something back out of it. It is a seam for the reason the acceptance is -- a test proves the chain of the
  // command, from the answer to the reload, without editing a skill -- and `retireDeps` passes the seams of the protocol
  // through untouched, so a test can keep the real retirement and replace the clock inside it.
  retire?: typeof retireLesson;
  retireDeps?: RetireDeps;
  // The collector of the silent signals of the session (M3, S6), the same object the wiring hydrates at every session start
  // and observes at the end of every turn: a confirmation is a run that names one of its suspicions by id. It is optional
  // because the command is also driven by tests and by hosts that hold no collector, and a session without one has no
  // suspicion to confirm -- the answer is `unknown-signal`, which spends nothing.
  signals?: SignalCollector;
}

export interface SkillImproveArgs {
  skill?: string;
  focus?: string;
  // The bank that measures the candidate (M1c): a run that names one asks for a directional improvement and its failures
  // are the cases the file declares. It is the material of the run -- the proposal reads it -- and the flow of the gate is
  // selected by it only when the run is not a defect (OA11): see measuredByBankOf below.
  bankPath?: string;
  // The suspicion a confirmation names (M3, S6): the id of one suspicion the collector holds open in this session. It is the
  // user's confirmation and the only thing that turns a suspicion into an attempt, and it composes with --bank and with
  // nothing else -- not even with the focus --: the attempt it opens is the directional one, whose cases are the expectation
  // and whose focus is the suspicion itself, so a run that also asked for another branch of this command is a usage error.
  signal?: string;
  // The bank describes the defect an artifact shows instead of the cases to measure. It is a property of the bank, and it
  // is spelled as a flag because the file itself cannot declare it (OA3): a bank that is not there cannot say what it is.
  defect?: boolean;
  // The candidate to gate instead of proposing one (M1c, OA7): a run that already staged its candidate does not spend a
  // second generation to measure it.
  staged?: string;
  // The report of the series of sessions (M3, S2): a read-only run that counts what the index already holds. It measures
  // nothing and takes no other flag, so it never reaches a proposal, a gate or an acceptance.
  metrics?: boolean;
  // The check of the accepted lessons (M3, S3): a read-only run that compares every accepted lesson still in force against
  // the record that accepted it. It spends nothing and takes no other flag either, so it reaches no proposal, no gate, no
  // acceptance and no model, and it does not touch the inventory of the skills.
  verify?: boolean;
  // The retirement of one accepted lesson (M3, S4): the slug of the lesson that stops applying. It is the second path of
  // this command that edits a skill, and unlike an acceptance it spends nothing -- no model, no gate, no candidate and no
  // staging write -- but it takes a lesson back out of use, so it names the lesson and the reason together.
  retire?: string;
  // Why the lesson stops applying (M3, S4): one key of RETIREMENT_REASONS, and the detail travels in the focus, because a
  // closed key with no sentence is a reason the record of the retirement cannot carry.
  reason?: RetirementReason;
}

// The syntax of the command, in one place: the usage line it prints and the sentence of a usage error. The flags are
// `--name=value` in a single token, so a focus with spaces cannot be confused with one of them, and `--` ends the flags.
const USAGE_SYNTAX = `<skill> [focus] [--bank=<path>] [--signal=<id>] [--defect] [--staged=<stagingPath>] [--metrics] [--verify] [--retire=<slug>] [--reason=<key>]`;

// The first token names the skill and the following ones are the focus, so a focus with spaces arrives as one string.
// Repeated whitespace is collapsed because it carries no meaning here, and an argument string of spaces is no argument at
// all.
//
// The three flags of M1c are recognized wherever they appear, and a flag is one token with its value after the equals sign
// -- a bank path with a space in it is one token, which is why the value never arrives as the next word. `--` ends the
// flags, and everything after it is the focus as written: that is the escape for a focus that starts with `--`, and the
// reason the parse can be strict about every other token that does.
//
// A usage error is thrown and not returned: this function answers the arguments or nothing, and the command reports the
// refusal it raises the way it reports every other refusal of the package -- nothing was read, nothing was spent and no
// line of the index was written.
export function parseSkillImproveArgs(args: string): SkillImproveArgs {
  const words = args.trim().split(/\s+/).filter((word) => word !== "");

  let skill: string | undefined;
  let bankPath: string | undefined;
  let signal: string | undefined;
  let staged: string | undefined;
  let retire: string | undefined;
  let reasonKey: string | undefined;
  let defect = false;
  let metrics = false;
  let verify = false;
  const focusWords: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];

    // The terminator: the rest of the line is the focus, whatever it spells.
    if (word === "--") {
      focusWords.push(...words.slice(index + 1));
      break;
    }

    if (word.startsWith("--")) {
      const flag = flagOf(word);
      const value = flag.value;
      if (flag.name === "defect" && value === undefined) {
        defect = true;
        continue;
      }
      if (flag.name === "metrics" && value === undefined) {
        metrics = true;
        continue;
      }
      if (flag.name === "verify" && value === undefined) {
        verify = true;
        continue;
      }
      if ((flag.name === "bank" || flag.name === "staged") && value !== undefined && value !== "") {
        if (flag.name === "bank") bankPath = value;
        else staged = value;
        continue;
      }
      if (flag.name === "signal" && value !== undefined && value !== "") {
        signal = value;
        continue;
      }
      if ((flag.name === "retire" || flag.name === "reason") && value !== undefined && value !== "") {
        if (flag.name === "retire") retire = value;
        else reasonKey = value;
        continue;
      }
      // A flag this command does not have, a boolean flag given a value, and a flag whose value is missing or empty are
      // one answer: the token is not one of the flags the command understands, and the sentence names the token.
      throw new SriFailClosedError(usageErrorText(word));
    }

    if (skill === undefined) {
      skill = word;
      continue;
    }
    focusWords.push(word);
  }

  // The check of S3 reads the index and the bytes it names, so it takes no other flag for the reason the report of S2 takes
  // none: a check and a measurement of a candidate are two different requests, and one invocation does one job. The refusal
  // comes before anything is read, so the index is not opened for a run that cannot answer, and it is asked before the refusal
  // of --metrics because --verify is the flag this run is about. Since S4 it is asked before the refusal of the retirement
  // too: `--verify --retire` names two flags that exist and do not compose, and the sentence below names both instead of
  // reaching the generic one of a token the command does not understand, which would misdescribe what happened.
  if (verify && (bankPath !== undefined || defect || staged !== undefined || metrics || retire !== undefined)) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --verify checks the accepted lessons against the records that accepted them and takes no other flag: --bank, --defect, --staged, --metrics and --retire belong to a run that proposes, measures, reports, checks or retires, and nothing was read. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  // A report of what the index already holds measures nothing, so it takes no other flag: reading the series and spending
  // a generation or a gate are two different requests, and answering one of them would leave the other silently unmeasured.
  // The refusal comes before anything is read, so the index is not opened for a run that cannot answer.
  if (metrics && (bankPath !== undefined || defect || staged !== undefined || retire !== undefined)) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --metrics reports the attempts already recorded and takes no other flag: --bank, --defect, --staged and --retire belong to a run that proposes, measures or retires, and nothing was read. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  // The confirmation of a suspicion (M3, S6) composes with --bank and with nothing else: the attempt it opens is the
  // directional one, whose expectation is the cases the bank declares, so a run that also gates a candidate that exists,
  // proposes from a defect, reports, checks or retires is two jobs under one invocation. It is asked before the
  // refusals below for the reason they are asked in that order: `--signal --retire` names two flags that exist and do not
  // compose, and the sentence has to name both instead of reaching the one of a retirement that names no detail.
  if (signal !== undefined && (staged !== undefined || defect || metrics || verify || retire !== undefined)) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --signal=<id> confirms one open suspicion with the bank that measures it and takes no other flag: --staged, --defect, --metrics, --verify and --retire belong to a run that gates a candidate that exists, proposes from a defect, reports, checks or retires, and nothing was read. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  // The focus of a confirmed suspicion is the suspicion itself (`signal:<kind>: <excerpt>`, signalFocusOf below), so a focus
  // the user spelled next to the flag would be text the run drops. Losing text in silence is the one thing a parser may not do:
  // the refusal names the flag and says where a focus of its own belongs. It is asked after the refusal above for the reason that
  // one is asked first: `--signal --staged` names two flags and this one names a text, and the sentence has to describe which of
  // the two happened.
  if (signal !== undefined && focusWords.length > 0) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --signal=<id> takes no focus: the focus of a confirmed suspicion is the suspicion itself, and a focus of its own belongs to an attempt without --signal. Nothing was read and nothing was spent. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  // A report of the series and a check of the accepted lessons answer for the whole index: the row of a skill is inside that
  // answer and never an answer of its own, so a name or a focus typed next to one of the two flags would be read by the user as
  // the subject of the answer and ignored by the run. The refusal comes before anything is read, the way the ones above do.
  if ((metrics || verify) && (skill !== undefined || focusWords.length > 0)) {
    const named = skill ?? focusWords.join(" ");
    throw new SriFailClosedError(
      `/${COMMAND_NAME} ${metrics ? "--metrics" : "--verify"} answers for the whole index and not for one skill: ${quote(named)} names the subject of a single run, and the row of a skill is inside the answer of the whole index. Nothing was read. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  // The retirement of S4 names one lesson and one reason, and it takes no other flag: it is the second path of this command
  // that edits a skill, so a run that also names a bank or a staged candidate would be two jobs under one invocation. It comes
  // after the refusals above because those are the ones whose sentence is about the flag of a report, of a check and of a
  // confirmation; this one names the material of a run, and it comes before anything is read.
  if (retire !== undefined && (bankPath !== undefined || defect || staged !== undefined)) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --retire=<slug> retires one accepted lesson and takes no other flag: --bank, --defect and --staged belong to a run that proposes or measures a candidate, and nothing was read. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  // The two flags of the retirement are one request: a reason without the lesson it explains names nothing, and a retirement
  // without a reason is the record of a decision nobody took. The detail of the reason travels in the focus, so a retirement
  // that names no focus has no sentence to keep either.
  if (retire === undefined && reasonKey !== undefined) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --reason=<key> says why a lesson is retired, and the run named no --retire=<slug>. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }
  if (retire !== undefined && reasonKey === undefined) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --retire=<slug> needs --reason=<key>: a lesson is retired for a recorded reason, out of ${RETIREMENT_REASONS.join(", ")}. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }
  if (retire !== undefined && skill === undefined) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --retire=<slug> needs the skill whose lesson it retires: the slug names a lesson of one skill, and the run named no skill. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }
  if (retire !== undefined && focusWords.length === 0) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --retire=<slug> needs the detail after --reason: the reason is a key of ${RETIREMENT_REASONS.join(", ")} and the sentence that says why this lesson stops applying is the focus of the run. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  // A defect is what a bank of the other profile describes, so the flag without the bank names no material at all: the
  // run would propose from an ask nobody wrote and then find nothing to measure it against, one generation later.
  if (defect && bankPath === undefined) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --defect needs the bank the defect is written down in: --defect says what --bank=<path> describes, and the run named no bank. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  const parsed: SkillImproveArgs = {};
  if (skill !== undefined) parsed.skill = skill;
  const focus = focusWords.join(" ");
  if (focus !== "") parsed.focus = focus;
  if (bankPath !== undefined) parsed.bankPath = bankPath;
  if (signal !== undefined) parsed.signal = signal;
  if (defect) parsed.defect = true;
  if (staged !== undefined) parsed.staged = staged;
  if (metrics) parsed.metrics = true;
  if (verify) parsed.verify = true;
  if (retire !== undefined) parsed.retire = retire;
  if (reasonKey !== undefined) parsed.reason = retirementReasonOf(reasonKey);
  return parsed;
}

// The key of a reason, out of the closed vocabulary of src/retirement.ts. A key outside it is a reason the record of a
// retirement cannot carry -- the schema declares the same five -- so it is refused as a usage error that names all five,
// before anything is read.
function retirementReasonOf(key: string): RetirementReason {
  const known = RETIREMENT_REASONS.find((reason) => reason === key);
  if (known === undefined) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} does not know the reason ${quote(key)}: --reason takes one of ${RETIREMENT_REASONS.join(", ")}, which is the vocabulary the record of a retirement declares. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }
  return known;
}

// The two shapes a flag token can take: the boolean one, and `--name=value` in a single token.
interface Flag {
  name: string;
  value?: string;
}

function flagOf(word: string): Flag {
  const equals = word.indexOf("=");
  if (equals === -1) return { name: word.slice(2) };
  return { name: word.slice(2, equals), value: word.slice(equals + 1) };
}

function usageErrorText(word: string): string {
  return `/${COMMAND_NAME} does not understand ${quote(word)}: the flags are --bank=<path>, --signal=<id>, --defect, --staged=<stagingPath>, --metrics, --verify, --retire=<slug> and --reason=<key>, each one token with its value after the equals sign, and -- ends the flags so that what follows is the focus. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`;
}

export async function runSkillImprove(
  args: string,
  ctx: SkillImproveContext,
  deps: SkillImproveDeps,
): Promise<void> {
  const run: Run = {
    ctx,
    deps,
    notify: deps.notify ?? channelOf(ctx, deps),
  };

  try {
    await improve(args, run);
  } catch (error) {
    // A refusal this package raises is reported, never thrown: nothing was written and the user is
    // the one who has to act on it. Any other error is a bug, and keeps its stack.
    if (!(error instanceof SriFailClosedError)) throw error;
    run.notify(error.message, "error");
  }
}

// One report channel for the whole run.
interface Run {
  ctx: SkillImproveContext;
  deps: SkillImproveDeps;
  notify: NotifyFn;
}

async function improve(args: string, run: Run): Promise<void> {
  const { ctx, deps, notify } = run;
  // The bank is resolved once, here, against the cwd of the session: the reader of src/case-bank.ts stats the path as it
  // arrives and therefore resolves it against process.cwd(), while the path a user types is relative to the directory the
  // session runs in. Both consumers below -- the proposal of a defect and the gate of the bank -- read this one value.
  const parsed = resolveBankPathOf(parseSkillImproveArgs(args), ctx.cwd);

  // M3, S2: --metrics reports what the index already holds and stops there. It is the one branch of this command that
  // measures nothing -- no generation, no gate, no acceptance, no staging write and no line of the index -- and it comes
  // before the offer below because it names no skill: the series is the whole of the base, not a row of one skill.
  if (parsed.metrics === true) {
    await reportMetrics(run);
    return;
  }

  // M3, S3: --verify checks the accepted lessons against the records that accepted them, and stops there. It is the second
  // branch that names no skill and spends nothing -- no generation, no model, no gate, no acceptance, no write and no line of
  // the index -- and it comes before the offer below for the reason --metrics does: the check covers the whole index and the
  // bytes it names, not a row of one skill.
  if (parsed.verify === true) {
    await reportStanding(run);
    return;
  }

  // No skill named: the command answers with what it can do and on which skills, so the offer is
  // the eligible set and never the whole inventory.
  if (parsed.skill === undefined) {
    notify(usageText(await listEligibleSkills(ctx, deps)), "info");
    return;
  }

  // M1c, OA7: --staged skips the proposal and enters the gate of the candidate the path names. A run that already has a
  // candidate does not spend a second generation to measure it, and the candidate is the one the path resolves -- the same
  // record, the same lesson and the same hashes the run that staged it wrote.
  if (parsed.staged !== undefined) {
    await gateStagedCandidateRun(parsed.skill, parsed.staged, parsed, run);
    return;
  }

  // M3, S4: --retire takes one accepted lesson back out of use and stops there. It is the second branch of this command that
  // edits a skill, and the only one that takes something out of it, so it comes before the proposal: a retirement spends no
  // generation, calls no model and measures nothing. The parser refuses a retirement that names no skill, no reason or no
  // detail, so the guard below is about an unreachable state and not a fourth way to refuse one -- a fall-through would
  // propose a candidate nobody asked for.
  if (parsed.retire !== undefined) {
    if (parsed.skill === undefined || parsed.reason === undefined || parsed.focus === undefined) {
      throw new SriFailClosedError(
        `/${COMMAND_NAME} --retire=<slug> needs the skill it retires from, the reason it retires for and the detail of that reason. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
      );
    }
    await retireAcceptedLesson(parsed.skill, parsed.retire, parsed.reason, parsed.focus, run);
    return;
  }

  // M3, S6: the confirmation of a suspicion, and the two answers it can have before anything is spent. The suspicion is
  // resolved out of the collector without consuming it, because a run that measures nothing must leave it open and
  // retryable: an id the collector does not hold is `unknown-signal`, and a confirmation that names no bank is the state of
  // an attempt with no baseline. Neither answer reads the settings, the inventory or the index, which is why both come before
  // any of them.
  let confirmed: Suspicion | undefined;
  if (parsed.signal !== undefined) {
    confirmed = confirmedSignalOf(parsed.signal, deps);
    if (confirmed === undefined) {
      notify(unknownSignalText(parsed.signal), "warning");
      return;
    }
    if (parsed.bankPath === undefined) {
      notify(signalWithoutBankText(confirmed), "warning");
      return;
    }
  }

  // The suspicion contributes the focus of the attempt and the bank the expectation: the focus lands in the one field the
  // record already carries, so the attempt says which suspicion it came from without a key of its own.
  const focus = confirmed === undefined ? parsed.focus : signalFocusOf(confirmed);

  // The proposal is written from the bank whenever the run names one, --defect included: the artifact the defect was read
  // from and the cases that measure it are declared in that file, and the branch reads both before it generates. Which base
  // measures the candidate is a separate question, and the answer is measuredByBankOf below.
  const result = await proposeSkill(
    {
      surface: SURFACE,
      skillName: parsed.skill,
      ...(focus === undefined ? {} : { focus }),
      ...bankFieldOf(parsed.bankPath),
      ...(parsed.defect === true ? { defect: true } : {}),
    },
    ctx,
    deps,
  );

  switch (result.kind) {
    case "unknown-skill":
      notify(unknownSkillText(SURFACE, result.skillName, result.standalone, result.eligible), "warning");
      return;
    case "not-eligible":
      recordEntry(run, result.entry);
      notify(notEligibleText(result.skill, result.reason), "warning");
      return;
    case "no-evidence":
      // The reason travels with the sentence: a run of the defect branch that could not read its bank or its artifact
      // answers with this outcome too, and the sentence may not claim the session showed nothing (M1c, S8).
      recordEntry(run, result.entry);
      notify(noEvidenceText(SURFACE, result.skill, result.entry.reason), "warning");
      return;
    case "no-model":
      notify(noModelText(SURFACE), "error");
      return;
    case "refused":
      // The generation refused, so the report comes first: it names the reason the user has to act
      // on, and the entry is the record of the attempt that produced it.
      notify(refusedText(result.skill, result.reason), "error");
      recordEntry(run, result.entry);
      return;
    case "proposed":
      recordEntry(run, result.entry);
      notify(proposedText(SURFACE, result.skill, result.draft.slug, result.staged.stagingPath, result.base), "info");
      // M3, S6: the candidate is in staging, so the confirmation is recorded here and not after the gate. What the user
      // confirmed is the attempt, and the gate does not decide whether a suspicion was confirmed: a gate that concludes
      // nothing leaves the candidate retryable and the suspicion closed, with the skill of the attempt on its line.
      if (parsed.signal !== undefined) deps.signals?.take(parsed.signal, result.skill.name);
      // M1: the candidate is gated here, and the acceptance below it is the only write into a skill this
      // package can reach.
      await gateAndAccept(
        {
          base: result.base,
          skill: result.skill,
          stagingPath: result.staged.stagingPath,
          ...bankFieldOf(measuredByBankOf(parsed)),
        },
        run,
      );
      return;
    default:
      // The six outcomes of the flow are the whole switch: a variant added to ProposeFlowResult makes
      // this line the first thing that stops compiling, instead of reaching the user as a run that
      // reported nothing. The gate's own union is switched on in gateAndAccept, under its own assertNever.
      return assertNever(result);
  }
}

// The report of the series (M3, S2), and with the check of S3 below one of the two branches of this command that read the
// index and nothing else. The base
// is the one the other branches write under -- the base of the run, or the agent directory of the session when the run
// names none -- so the numbers are the numbers of the attempts this command recorded. The index is read by
// src/ledger.ts, which answers an empty ledger for a machine that never ran an attempt: a report of nothing is not an
// error, it is a report that says there is nothing to measure yet (src/messages.ts).
async function reportMetrics(run: Run): Promise<void> {
  const { deps, notify } = run;
  const base = deps.base ?? writeBase(deps.agentDir ?? getAgentDir());
  const ledger = await readLedger(base);

  notify(withDamageOf(metricsText(metricsOf(ledger)), ledger, base), "info");
}

// The check of the accepted lessons (M3, S3), and with --metrics the only branches of this command that read the index and
// nothing else. The base and the reader are the ones of the report above, so the two answers describe the same index; what
// this branch adds is the bytes: each accepted lesson is compared against the record that accepted it (src/standing.ts),
// which is the tie M2 wrote down and no surface of the package could verify until now. It decides nothing, proposes nothing,
// gates nothing and writes nothing: it describes what the skills on disk are worth.
async function reportStanding(run: Run): Promise<void> {
  const { deps, notify } = run;
  const base = deps.base ?? writeBase(deps.agentDir ?? getAgentDir());
  const ledger = await readLedger(base);

  notify(withDamageOf(standingText(await standingOf(ledger)), ledger, base), "info");
}

// The one line either report adds when the index stopped before its end (M3, S10). `standingOf` and `metricsOf` are left as
// they are -- they count the lines the reader answered -- and the branch is the one that knows there was something behind
// them: an index an interrupted append cut gives a shorter report than the truth, and a shorter report reads as a better one.
// The sentence is appended to the answer and never printed alone, because it is a property of that answer.
function withDamageOf(answer: string, ledger: Ledger, base: string): string {
  if (ledger.damaged === null) return answer;
  return `${answer}\n${damagedIndexText(ledger.damaged, indexPathOf(base))}`;
}

// The path of the index of a base, which is what a report about its damage and a refusal of a retirement both name.
function indexPathOf(base: string): string {
  return path.join(stateDir(path.resolve(base)), ATTEMPTS_FILE);
}

// The retirement of one accepted lesson (M3, S4), from the index to the write. Three questions in this order, and the
// order is the whole answer:
//
//   1. is the index readable at all? A damaged index is not an index without an acceptance: the line an interrupted append
//      cut may be exactly the `accepted` of this slug, so answering `never-accepted` here would be a false statement about
//      the skill. The refusal names the line that broke and the file, it writes nothing, and it is reported as an error of
//      the run instead of thrown: nothing was written and the index is what the user repairs.
//   2. does the index hold an acceptance of this slug of this skill, with a record that can be read? That record is the
//      authority of the retirement: its pair of hashes is the pre-image the protocol verifies, its title is what the record
//      of the retirement carries, and its own path is what the retirement points at. A slug with no such line is
//      `never-accepted`, which is the statement that the index does not hold an accepted lesson of that slug whose hashes
//      can be verified -- the pair is what the reason is about, and a record nobody can open establishes no pair.
//   3. the protocol of src/retirement.ts runs, with the skill block the record of the acceptance carries and not the one the
//      inventory answered: the `realDir` of the acceptance is the path it wrote through, which is the one that survives a
//      symlink, and it is the rule src/standing.ts follows for the same reason.
//
// The inventory is read for one thing only: to answer a name nobody knows the way every other branch of this command
// answers it (F6). Nothing here reads settings, proposes, gates or measures: the merit of a retirement is the reason the
// user gave.
async function retireAcceptedLesson(
  skillName: string,
  slug: string,
  reasonKey: RetirementReason,
  detail: string,
  run: Run,
): Promise<void> {
  const { ctx, deps, notify } = run;
  const agentDir = deps.agentDir ?? getAgentDir();
  const skills = await (deps.listSkills ?? listSkills)({ cwd: ctx.cwd, agentDir });
  const skill = findSkill(skills, skillName);

  if (skill === undefined) {
    // A name nobody knows, answered the way the command answers it everywhere else: the standalone the name may be, and
    // the eligible set the user can ask for instead.
    const standalone = skills.find((entry) => entry.kind === "standalone" && entry.name === skillName) ?? null;
    notify(unknownSkillText(SURFACE, skillName, standalone, await listEligibleSkills(ctx, deps)), "warning");
    return;
  }

  const base = deps.base ?? writeBase(agentDir);
  const ledger = await readLedger(base);
  const indexPath = indexPathOf(base);

  // Step 1: the index that stops at a truncated line. Nothing is decided and nothing is written, because the line the append
  // cut may be the acceptance this run is about. The line is the physical one -- the position src/ledger.ts counted, one more,
  // the way damagedIndexText converts it -- because the sentence names a line of a file the user opens, and a cut on the first
  // line reported as line 0 would send the reader above the line to repair.
  if (ledger.damaged !== null) {
    notify(
      retireRejectedText(skill, {
        reason: "unreadable-index",
        detail: `the index ${quote(indexPath)} is unreadable at line ${ledger.damaged.index + 1}: ${ledger.damaged.problem}`,
      }),
      "error",
    );
    return;
  }

  // Step 2: the acceptance of this slug, which is the whole precondition of the retirement.
  const accepted = acceptedLessonOf(ledger, skill.name, slug);
  if (accepted === null) {
    notify(
      retireRejectedText(skill, {
        reason: "never-accepted",
        detail: `the index ${quote(indexPath)} holds no accepted lesson ${quote(`lessons/${slug}.md`)} of skill ${quote(skill.name)} whose record can be read`,
      }),
      "error",
    );
    return;
  }

  // Step 3: the protocol, with the material of the acceptance and the reason of this run.
  const outcome = await (deps.retire ?? retireLesson)(
    {
      base,
      skill: {
        name: accepted.record.skill.name,
        dir: accepted.record.skill.dir,
        realDir: accepted.record.skill.realDir,
        wasSymlink: accepted.record.skill.wasSymlink,
      },
      lesson: {
        slug,
        title: accepted.record.candidate.title,
        contentHash: accepted.record.candidate.contentHash,
        bodyHash: accepted.record.candidate.bodyHash,
      },
      acceptedHistoryPath: accepted.historyPath,
      // The parser refuses a retirement without a detail, so the sentence of the reason is never the empty string.
      reason: { key: reasonKey, detail },
    },
    deps.retireDeps,
  );

  if (!outcome.ok) {
    // A retirement the protocol refused wrote nothing of the tombstone, the record or the index (the reference line may be
    // the one it stopped at, and the detail says so), so the sentence is the whole answer and the run stops here.
    notify(retireRejectedText(skill, outcome.error), "error");
    return;
  }

  notify(
    retiredText(
      skill,
      slug,
      outcome.value.lessonPath,
      outcome.value.retirementPath,
      outcome.value.referenceRemoved,
    ),
    "info",
  );

  // The same closing the acceptance has, for the same reason: the writes are on disk, so the session reads the skill again
  // here instead of at the next session start. waitForIdle first, because pi warns and returns without reloading while the
  // agent is streaming; and nothing may run after reload, because the code that followed lands in the frame the reload
  // invalidated, where every getter of the context throws. The warning below reads no member of the context.
  await ctx.waitForIdle();
  try {
    await ctx.reload();
  } catch (error) {
    warnAfterReload(run, retirementReloadFailedText(toErrorMessage(error)));
  }
  return;
}

// The authoritative record of the acceptance a retirement is about: the latest `accepted` line of this skill whose record
// names this slug. The slug is not a field of the line -- the line joins by `candidateHash` and points at the record with
// `historyPath` -- so the record of each accepted line is what tells the slug, and a line whose record cannot be read tells
// nothing and is passed over: the `never-accepted` that follows says the hashes of the acceptance could not be verified,
// which is exactly what happened.
interface AcceptedLesson {
  record: DecisionRecord;
  historyPath: string; // the decision.json of the acceptance, absolute
}

function acceptedLessonOf(ledger: Ledger, skillName: string, slug: string): AcceptedLesson | null {
  for (const entry of [...ledger.lines].reverse()) {
    if (entry.line.event !== "accepted" || entry.line.targetSkill !== skillName) continue;

    const record = entry.record;
    if (record === null || entry.recordPath === null || record.candidate.slug !== slug) continue;

    return { record, historyPath: entry.recordPath };
  }

  return null;
}

// Whether a bank measures the candidate of this run (M1c): a run that named one and did not ask for a defect is measured by a
// case bank, and every other run -- the session's failures, and the defect an artifact shows, which the replay base measures
// (OA11) -- by a replayed budget. The answer is the bank to hand the gate, and undefined is the answer "by replay".
//
// It is read by the dispatch of the gate and by nothing else: the proposal of a defect is still written from the bank, and a
// function that also emptied the request would take the material of the branch away from it. The record of the candidate is
// what catches a surface that got it wrong: each flow refuses a record of the other base with `basis-mismatch`.
function measuredByBankOf(parsed: SkillImproveArgs): string | undefined {
  return parsed.defect === true ? undefined : parsed.bankPath;
}

function bankFieldOf(bankPath: string | undefined): { bankPath?: string } {
  return bankPath === undefined ? {} : { bankPath };
}

// The suspicion a confirmation names (M3, S6), out of the collector the wiring passes with the dependencies. It reads
// pending() and not take(), because consuming a suspicion is what the run that measured something does and not what the run
// that answers does: a confirmation with no bank leaves the id open and retryable. A session without a collector has no
// suspicion to confirm, and the answer it gets is the one an id nobody raised gets -- the run named a suspicion this session
// cannot see.
function confirmedSignalOf(id: string, deps: SkillImproveDeps): Suspicion | undefined {
  const collector = deps.signals;
  if (collector === undefined) return undefined;

  return collector.pending().find((suspicion) => suspicion.id === id);
}

// The focus of an attempt a confirmation opens (M3, S6): the suspicion as one string, in the field the record already carries
// -- the focus of the trigger -- so the line of decision.json says which suspicion the attempt came from without a key of its
// own and without a delta of the schema.
function signalFocusOf(suspicion: Suspicion): string {
  return `signal:${suspicion.kind}: ${suspicion.excerpt}`;
}

// The answer of a confirmation that names no bank (M3, S6): the cases a bank declares are the baseline a confirmed suspicion
// is measured against, so a run without one has no baseline to measure an attempt against and spends nothing. That is the
// state the base of the bank answers as `no-baseline`, and the suspicion is left open, which is the whole difference between
// this answer and a confirmation that consumed it.
function signalWithoutBankText(suspicion: Suspicion): string {
  return `the confirmation of the suspicion ${quote(suspicion.id)} names no --bank=<path>, and the cases a bank declares are the baseline a confirmed suspicion is measured against: nothing was spent, no candidate was staged and no baseline was read, so the suspicion stays open and the same confirmation can be given again with a bank.`;
}

// The bank a run names, resolved against the cwd of the session and not against the cwd of the process: the reader stats
// the path it is given, and the path a user types is the one a shell would resolve in the directory the session runs in.
// A run that names no bank is returned as it arrived.
function resolveBankPathOf(parsed: SkillImproveArgs, cwd: string): SkillImproveArgs {
  return parsed.bankPath === undefined ? parsed : { ...parsed, bankPath: path.resolve(cwd, parsed.bankPath) };
}

// What the gate of one run is pointed at, and the only three things both branches need: the base the candidate was written
// under, the skill it belongs to -- resolved by the loop for a candidate it staged, by the inventory for a candidate that
// already exists -- and the path of the candidate, in the spelling the records use (relative to that base).
interface GateTarget {
  base: string;
  skill: SkillRef;
  stagingPath: string;
  bankPath?: string;
}

// The branch of --staged (M1c, OA7): no proposal, no staging write, no attempt line of its own -- the run only measures a
// candidate that exists. The skill is resolved from the inventory by name, the way the tool's gate resolves it, because
// there is no loop to resolve it here and the candidate directory is named after it.
async function gateStagedCandidateRun(
  skillName: string,
  stagingPath: string,
  parsed: SkillImproveArgs,
  run: Run,
): Promise<void> {
  const { ctx, deps, notify } = run;
  const agentDir = deps.agentDir ?? getAgentDir();
  const skills = await (deps.listSkills ?? listSkills)({ cwd: ctx.cwd, agentDir });
  const skill = findSkill(skills, skillName);

  if (skill === undefined) {
    // A name nobody knows, answered the way the command answers it everywhere else: the standalone the name may be, and
    // the eligible set the user can ask for instead (F6).
    const standalone = skills.find((entry) => entry.kind === "standalone" && entry.name === skillName) ?? null;
    notify(unknownSkillText(SURFACE, skillName, standalone, await listEligibleSkills(ctx, deps)), "warning");
    return;
  }

  await gateAndAccept(
    {
      base: deps.base ?? writeBase(agentDir),
      skill,
      stagingPath,
      ...bankFieldOf(measuredByBankOf(parsed)),
    },
    run,
  );
}

// The chain M1 adds (Q12, OA1): a candidate is gated, and it is written into the skill only when the gate passes. This
// function decides nothing about either step -- it reports, and it calls the acceptance exactly where the gate said it may.
// M1c adds one branch and no second write: a gate of the bank base that found no baseline is a state of the attempt, so it is
// reported with the path the retry needs and the skill is left alone.
async function gateAndAccept(target: GateTarget, run: Run): Promise<void> {
  const { notify } = run;

  // The gate spends tokens, and this is the last moment at which nothing has been spent. The budget itself is
  // fixed inside the gate (planGate, from the design and the items of the diagnosis), so the sentence says
  // what is about to happen instead of a count this surface would have to recompute for itself.
  notify(gateStartedText(target.skill), "info");

  const result = await runGate(target, run);

  switch (result.kind) {
    case "refused":
      // A candidate this version cannot gate is a refusal of the whole run: nothing was written and no run was
      // spent, so the reason has to reach the user as the error it is instead of as a verdict of the gate.
      throw new SriWriterError(
        `the gate refused the candidate for skill ${quote(target.skill.name)}: ${result.rejection.detail}`,
        target.stagingPath,
      );
    case "gate-rejected":
      // A rejection the judge produced names the case and its sentence, and the flow keeps both in the detail of the result,
      // which is the same text the line of the index carries (M4).
      notify(gateRejectedText(SURFACE, target.skill, result.reason, result.usedRuns, result.detail), "warning");
      return;
    case "gate-abstained":
      notify(gateAbstainedText(SURFACE, target.skill, result.reason, result.detail), "warning");
      return;
    case "no-baseline":
      // Nothing was spent and the record was left in the state it was, so the attempt is retryable (OA1, OA9): the
      // sentence carries the reason of the reader of the bank and the path the retry is pointed at.
      notify(noBaselineText(SURFACE, target.skill, result.reason, result.stagingPath), "warning");
      return;
    case "gate-accepted":
      notify(gatePassedText(SURFACE, target.skill, result.plannedRuns, result.usedRuns), "info");
      await acceptIntoSkill(target, result, run);
      return;
    default:
      // The three verdicts, the refusal and the answer of a base with no baseline are the whole union of the two flows: a
      // variant added there stops compiling here, instead of reaching the user as a gate that reported nothing.
      return assertNever(result);
  }
}

// The gate of one candidate, in the flow of its base. The two flows answer about the same candidate and are pointed at it the
// same way; what differs is the material, and the material is decided by the `bankPath` the caller put in the target -- which
// the callers fill from measuredByBankOf, because a defect names a bank and is still measured by a replay.
async function runGate(target: GateTarget, run: Run): Promise<GateFlowResult | DirectionalGateResult> {
  const { ctx, deps } = run;
  // The agent directory the loop read the settings and the inventory from, so the replay is measured against the skills
  // this session had (OA6).
  const agentDir = deps.agentDir ?? getAgentDir();
  const request = {
    base: target.base,
    agentDir,
    cwd: ctx.cwd,
    stagingPath: target.stagingPath,
    // The skill the loop resolved and wrote the candidate for, or the one the inventory answered for a staged candidate:
    // the gate refuses a candidate named after another skill.
    skill: target.skill,
  };

  if (target.bankPath === undefined) {
    return await (deps.gate ?? gateStagedCandidate)(request, deps.gateDeps);
  }

  // The base of the bank needs the model of the session twice -- one to replay the cases of the two arms, one to judge the
  // answers of the candidate (OA5) -- so a session without one cannot gate it at all. The wiring is the one of
  // src/model-call.ts, shared with the tool: it answers the request and the seams of this flow, or the refusal of a session
  // with no model, which this surface reports as the error it is.
  const wired = wireDirectionalGate({
    context: ctx,
    sessionId: ctx.sessionManager.getSessionId(),
    request,
    bankPath: target.bankPath,
    ...(deps.gateDeps === undefined ? {} : { gateDeps: deps.gateDeps }),
  });
  if (!wired.ok) throw new SriFailClosedError(noModelGateText(SURFACE, target.skill));

  return await (deps.gateDirectional ?? gateDirectionalCandidate)(wired.value.request, wired.value.deps);
}

// Step 7 of the protocol of §7, and the only path of this package that writes inside a skill. Everything it
// needs comes from two places and no third one: the candidate the gate measured, and the record the gate rewrote,
// which carries the candidate it measured and the hashes of the skill it measured it against.
async function acceptIntoSkill(target: GateTarget, gate: GateConcludedResult, run: Run): Promise<void> {
  const { ctx, deps, notify } = run;
  const { record, skillContentHash } = await stagedRecordOf(target, gate);

  // D-C (OA10, S7): the verdict the acceptance re-checks before it writes. It is resolved here, after the gate and as late
  // as this surface can, because the settings may have changed while the gate spent its budget -- and it travels as data
  // because the acceptance reads no settings of its own. The rule and the reader are the ones the loop uses, so a run and
  // its acceptance cannot disagree about what the settings say.
  const eligibility = eligibilityOfSkill(target.skill, deps);

  // The bytes the acceptance writes are the bytes the candidate holds, read from the lesson the record names and verified
  // against the pair of hashes it declares (verifiedStagedLesson, the guard both gate bases run before they spend). Nothing
  // is serialized here: a run that skipped the proposal (--staged) has no draft to serialize, and a second serialization
  // would be a second answer to "are these the bytes the gate measured" -- the file is, and the record says which one.
  const lesson = await verifiedStagedLesson(path.resolve(target.base, gate.stagingPath), record);
  if (!lesson.ok) {
    throw new SriWriterError(
      `the candidate for ${quote(target.skill.name)} no longer holds the lesson its record declares: ${lesson.error}`,
      gate.decisionPath,
    );
  }

  const outcome = await (deps.accept ?? acceptCandidate)(
    {
      base: target.base,
      // realDir and not dir: the acceptance writes through the real path of a skill reached by a symlink (Q11).
      skill: { name: target.skill.name, realDir: target.skill.realDir },
      candidate: {
        slug: record.candidate.slug,
        title: record.candidate.title,
        lessonText: lesson.value,
        contentHash: record.candidate.contentHash,
      },
      decision: record,
      // The SKILL.md the gate measured: an edit between the gate and this call is refused as drift instead of
      // being published under a verdict about a skill that no longer exists.
      expectedSkillContentHash: skillContentHash,
      eligibility,
      failureSignature: record.diagnosis.failureSignature,
    },
    deps.acceptDeps,
  );

  if (!outcome.ok) {
    // A candidate the protocol refused wrote nothing: the snapshot is taken before the first edit and the lesson
    // is withdrawn when the reference line cannot land, so the detail is the whole answer and the run stops here.
    notify(outcome.error.detail, "error");
    return;
  }

  notify(
    acceptedText(target.skill, record.candidate.slug, outcome.value.lessonPath, outcome.value.historyPath),
    "info",
  );

  // Step 8, and the last thing an accepting run does: the acceptance has answered and its writes are on disk, so the
  // session reads the skill again here instead of at the next session start. The reload is a call on the context pi
  // hands a command -- the two members it needs are declared on SkillImproveContext, at the top of this file -- and
  // not a step of the acceptance, which sees no context at all. The notice above comes first because it is the last
  // line the frame that still has a context can write.
  //
  // waitForIdle first: pi warns and returns without reloading while the agent is streaming, and the handler never
  // sees a rejection, so without this call the reload would be lost in silence.
  //
  // Nothing may run after reload -- the code that followed lands in the frame the reload invalidated, where every
  // getter of the context throws. That is an invariant of this site, not a note about one version of it, and it is
  // the reason the warning below reads no member of the context.
  await ctx.waitForIdle();
  try {
    await ctx.reload();
  } catch (error) {
    warnAfterReload(run, reloadFailedText(toErrorMessage(error)));
  }
  return;
}

// The verdict of one skill under the settings of this run, over the spellings it answers to (M3, S7). The rule is
// src/eligibility.ts's and the reader is the seam the loop reads the settings with, resolved here because the acceptance
// may not read settings at all: what it re-checks is the verdict, not the file.
function eligibilityOfSkill(skill: SkillRef, deps: SkillImproveDeps): Eligibility {
  const agentDir = deps.agentDir ?? getAgentDir();
  const config = (deps.readConfig ?? readSriConfig)(path.join(agentDir, SETTINGS_FILE));
  return isEligibleUnderAnySpelling(spellingsOfSkill(skill), config);
}

// The record the gate left in the candidate, with the hash of the skill it measured. The acceptance writes the
// first into the history of the skill and compares the second with the SKILL.md on disk, so both come from the
// file the gate rewrote instead of from a second reading of the candidate built here.
async function stagedRecordOf(
  target: GateTarget,
  gate: GateConcludedResult,
): Promise<{ record: DecisionRecord; skillContentHash: string }> {
  const resolved = await resolveStagedCandidate(target.base, target.skill.name, gate.stagingPath);
  if (!resolved.ok) {
    throw new SriWriterError(
      `the gate answered ${quote(gate.kind)} for ${quote(gate.decisionPath)} and its record cannot be read: ${resolved.error.detail}`,
      gate.decisionPath,
    );
  }

  const record = resolved.value;
  // The record is the authority of the two steps: a gate that answered one verdict and a record that carries
  // another describe two runs, and the acceptance is the one step that must never guess between them.
  if (record.gate.status !== "gate-accepted") {
    throw new SriWriterError(
      `the gate answered ${quote(gate.kind)} for ${quote(gate.decisionPath)} and the record says ${quote(record.gate.status)}: nothing was accepted`,
      gate.decisionPath,
    );
  }

  // The hash of the SKILL.md the gate measured is read from the preregistration and not from the result of a basis:
  // that block is the one the two bases share, and the result of the replay base -- where M1 kept it -- is null in a
  // gate of the case-bank base. A preregistration with no hash describes a gate that measured nothing this acceptance
  // can be compared against, so the read fails closed instead of accepting under a hash nobody recorded.
  const skillContentHash = record.gate.preregistration.skillContentHash;
  if (skillContentHash === undefined) {
    throw new SriWriterError(
      `the gate answered ${quote(gate.kind)} for ${quote(gate.decisionPath)} and its preregistration carries no skillContentHash: nothing was accepted`,
      gate.decisionPath,
    );
  }

  return { record, skillContentHash };
}

// The report channel. With UI the notification is the result; without it the runner hands the
// extension a no-op ui context (dist/core/extensions/runner.js:133-136), so notify would swallow the
// text. The command context carries no channel of its own, so a wiring that wants the text in the
// session passes sendMessage; when nothing does, stderr is where pi itself reports without UI
// (runner.js:455-457).
function channelOf(ctx: SkillImproveContext, deps: SkillImproveDeps): NotifyFn {
  return (message, type) => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
      return;
    }

    const sendMessage = deps.sendMessage;
    if (sendMessage !== undefined) {
      sendMessage({ customType: ENTRY_TYPE, content: message, display: true });
      return;
    }

    console.error(`${COMMAND_NAME}: ${message}`);
  };
}

// The reload can fail with the runner already gone, so the warning that reports it reads no member of the
// context: deps.notify is the channel a test replaces and it touches no context, sendMessage goes through the
// extension API, and console.error is the last one.
function warnAfterReload(run: Run, message: string): void {
  const notify = run.deps.notify;
  if (notify !== undefined) {
    notify(message, "warning");
    return;
  }

  const sendMessage = run.deps.sendMessage;
  if (sendMessage !== undefined) {
    sendMessage({ customType: ENTRY_TYPE, content: message, display: true });
    return;
  }

  console.error(`${COMMAND_NAME}: ${message}`);
}

function recordEntry(run: Run, entry: ImprovementEntry): void {
  const append = run.deps.appendEntry;
  if (append === undefined) {
    // The entry is the /tree view of the attempt, not the audit trail: the line in
    // state/attempts.jsonl already carries the same hashes and the same skill, and staging is
    // written either way. A run that cannot record the entry says so instead of pretending.
    run.notify(
      `${ENTRY_TYPE}: the session entry was not recorded: the run has no appendEntry channel.`,
      "warning",
    );
    return;
  }

  // F2: the same reasoning covers a channel that throws. The durable record of the run is the index
  // line and the candidate, and the entry is the view of it in /tree, so a failure here is a warning
  // and never the outcome: the command still reports the candidate it staged or the refusal it got.
  try {
    append(ENTRY_TYPE, entry);
  } catch (error) {
    run.notify(
      `${ENTRY_TYPE}: the session entry was not recorded: ${toErrorMessage(error)}`,
      "warning",
    );
  }
}

// The command's own sentence: what is about to be spent, said before it is (no other surface spends it, and a
// gate of twelve runs is a long silence otherwise).
function gateStartedText(skill: SkillRef): string {
  return `gating the candidate for skill ${quote(skill.name)} with a paired replay of the skill against the skill plus the lesson; the gate spends tokens on every run, and the candidate is written into the skill only if it passes.`;
}

// The command's own sentence: the usage line and the offer of the eligible set, which no other
// surface prints. The flags of M1c, the two that read the index, the two of the retirement (M3, S4) and the one of the
// confirmation (M3, S6) are in the syntax line because the parser accepts them and the usage error names them; what each one
// is for is the description of the command and of the tool (extensions/index.ts).
//
// The four ways of giving feedback are listed here and not in a description, because the user who typed the command
// alone is exactly the one the channel is for (M1c, S11, Q26): the failures of the session, the two profiles of a bank
// and the tool the model registers a correction with. Each line is the invocation that reaches it, so the help is
// usable without reading anything else.
//
// The syntax line shows the focus and --signal together, and the parser refuses the pair (M3, S11b): the focus of a
// confirmed suspicion is the suspicion itself, so a text typed next to the id is a usage error and not text the run drops.
// The clause is in the description because the syntax line cannot say it, and a help that published two things that cannot
// go together would turn the refusal of its own text into a bug report.
function usageText(eligible: readonly SkillRef[]): string {
  return [
    `Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    "Stages a lesson candidate for one skill -- from the failures of this session, or from the cases a --bank=<path> declares, with --defect when that bank describes a defect an artifact shows -- gates it with a paired replay and accepts it into the skill only when the gate passes; --staged=<stagingPath> gates a candidate that is already in staging, and the gate spends tokens; --metrics reports the numbers of the attempts already recorded, with no generation and no gate; --verify checks the accepted lessons against the records that accepted them, with no model, no gate and no write; --signal=<id> --bank=<path> confirms one suspicion the collector holds open as a directional attempt on the skill, measured by the cases of that bank, and a confirmation that names no bank spends nothing and leaves the suspicion open; a focus next to --signal is refused instead of dropped, because the focus of a confirmed suspicion is the suspicion itself; --retire=<slug> --reason=<key> retires one accepted lesson of the skill for a recorded reason, and the detail of that reason is the focus of the run.",
    "Feedback it can record, in four ways:",
    `  - a tool failure of this session: /${COMMAND_NAME} <skill> [focus]`,
    `  - a directional improvement, measured against the cases a bank declares: /${COMMAND_NAME} <skill> --bank=<path>`,
    `  - a defect an artifact shows, measured against the truth that bank declares: /${COMMAND_NAME} <skill> --bank=<path> --defect`,
    `  - a correction or a rejection the model registers before anything is spent: the ${SKILL_IMPROVE_TOOL_NAME} tool`,
    `Eligible skills: ${listedNames(eligible)}.`,
  ].join("\n");
}
