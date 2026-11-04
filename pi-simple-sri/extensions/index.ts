import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  runSkillImprove,
  type ImprovementEntry,
  type SkillImproveContext,
  type SkillImproveDeps,
  type SkillImproveMessage,
  type SkillImproveUi,
} from "../src/command-skill-improve.ts";
import type { ImproveFlowContext, ImproveFlowDeps } from "../src/improve-flow.ts";
import { feedbackNoticeText } from "../src/messages.ts";
import { COMMAND_NAME, REPLAY_ENV_VAR, SKILL_IMPROVE_TOOL_NAME } from "../src/names.ts";
import {
  createSkillImproveTool,
  skillImproveParams,
  type SkillImproveParams,
  type SkillImproveToolDeps,
  type ToolDetails,
} from "../src/tool-skill-improve.ts";

// The wiring (P10): the two surfaces of the loop and the notice of a session start, registered on pi's
// extension API, and nothing else. Every decision this package makes lives in src/; this file decides only which
// surface is called and which dependencies it is called with.
//
//   /skill-improve <skill> [focus] [--bank=<path>] [--defect] [--staged=<stagingPath>]  -> runSkillImprove
//   skill_improve { action, skill, focus, stagingPath, bankPath, defect }               -> createSkillImproveTool
//
// Both run the same loop (src/improve-flow.ts), so the command and the tool cannot disagree about
// what is eligible, what counts as evidence or what a candidate looks like; both can gate a candidate
// (src/gate/flow.ts, or src/gate/directional-flow.ts when the run names a bank), and only the command carries a gate
// that passes into the acceptance (src/gate/acceptance.ts). The tool receives its dependencies at registration time and
// the command receives the same ones at call time.
//
// The third registration is not a surface but a line: the one event this file listens to reports feedbackNoticeText
// (src/messages.ts) at the start of every session whose reason is not "reload" (M1c, S11), so a user who never reads a
// description and a model that never reads a notice both hear that the feedback of a session can be recorded.
//
// What the factory does not do is as much part of the contract as what it does: no process, no
// socket, no timer, no file read (docs/extensions.md:58-60). The root below is path arithmetic; the
// settings, the inventory, the model, the writer and the clock are all resolved inside a run. That
// is also why no session_shutdown handler is registered: nothing here holds a resource that would
// need one, and the one session_start handler of M1c holds nothing either -- it reports one line and
// returns.
//
// Importing this module runs nothing either. The only statements at module level declare types and
// constants, so a `pi -e` that loads the file and never calls the factory registers nothing.
//
// OA8: the child of a replay runs with this extension loaded, because the child is not started with
// -ne/--no-extensions -- cutting extensions would change the environment the failure was measured
// in. The mitigation is the other side: src/gate/replay-runner.ts puts PI_SIMPLE_SRI_REPLAY=1 in the
// child's environment, and the factory below registers nothing when it reads that value, so a replay
// cannot start another propose or gate over itself. The variable is read when the factory is called,
// never when the module is imported, which keeps the import free of environment reads.

// The description is what the command list shows, so it names the syntax and the things a user must know before running it:
// the two materials a candidate can be written from (the failures of the session, or the cases of a bank), the flag that
// describes a defect, the flag that gates a candidate that already exists, that the candidate is gated before anything is
// written, and that the gate spends tokens. This command is also the only surface that may accept a candidate (Q12), and the
// description says so instead of promising that nothing is ever edited.
const COMMAND_DESCRIPTION = `Stage a lesson candidate for one installed skill -- from the failures of this session, or from the cases a --bank=<path> declares, with --defect when that bank describes a defect an artifact shows instead of the cases to measure --, gate it with a paired replay and accept it into the skill only when the gate passes: /${COMMAND_NAME} <skill> [focus] [--bank=<path>] [--defect] [--staged=<stagingPath>]. --staged=<stagingPath> gates a candidate that is already in staging instead of proposing a second one, and a bank that is absent or unreadable spends nothing, leaves the candidate in staging and leaves the attempt retryable. The gate spends tokens on every run, and this command is the only surface that accepts: the ${SKILL_IMPROVE_TOOL_NAME} tool never does.`;

// The seams a test may replace: everything the loop resolves for itself, plus the two gate flows the command chains
// after it and the tool runs on its own. The gate's own seams are the tool's, and the acceptance's are not here
// at all -- only the command accepts (Q12), every test of that step drives the command directly, and the
// wiring is what keeps the tool's dependencies free of any seam that could write a skill. No path travels
// through the wiring: the write base follows the agent directory, so the factory passes nothing of its own.
export type SriSeams = ImproveFlowDeps & Pick<SkillImproveToolDeps, "gate" | "gateDirectional" | "gateDeps">;

// The command registration as this factory writes it, with the handler's context narrowed to the
// fields the command reads (SkillImproveContext, src/command-skill-improve.ts). pi's own
// ExtensionCommandContext satisfies it, which the narrowing in sriExtension below proves at compile
// time; narrowing what a handler reads is what lets a test drive it with a six-field fake instead of
// a whole host context.
export interface SriCommandRegistration {
  description?: string;
  handler: (args: string, ctx: SkillImproveContext) => Promise<void>;
}

// The registered tool, narrowed the same way: pi's ToolDefinition with the parameters, the details
// and the context of the one tool this package registers. execute() only ever reads the four
// members of ImproveFlowContext, so that is what the wiring hands it.
//
// label is here because pi requires it and because the narrowing in sriExtension below compares this
// shape against the host's ToolDefinition: the members a host tool must carry stay, only the context
// narrows.
export interface SkillImproveToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: typeof skillImproveParams;
  execute(
    toolCallId: string,
    params: SkillImproveParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<ToolDetails> | undefined,
    ctx: ImproveFlowContext,
  ): Promise<AgentToolResult<ToolDetails>>;
}

// Why a session started, as pi reports it (SessionStartEvent.reason), and the slice of the context the one
// event handler of this package reads.
//
// "reload" is the value that is not a session with news in it: pi reloads after an acceptance (M2) and the
// notice of a reloaded session would be the line the reader has just read, so the handler stays silent on it
// (OA8). The context is narrowed to the one channel the handler uses, the way SriCommandRegistration narrows
// the command's: a test drives the handler with one member, and pi's own context satisfies it at the
// assignment in sriExtension below.
export interface SriSessionStartEvent {
  readonly type: "session_start";
  readonly reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface SriNoticeContext {
  readonly ui: SkillImproveUi;
}

export type SriSessionStartHandler = (event: SriSessionStartEvent, ctx: SriNoticeContext) => void;

// The slice of ExtensionAPI this package uses: the two registrations, the two channels that only
// the extension API carries (appendEntry and sendMessage do not exist on the context pi hands a
// handler or a tool), and the one event it listens to. The session entry of this package is always the
// same payload, so appendEntry is narrowed to it here rather than at every call site.
export interface SriExtensionApi {
  registerCommand(name: string, options: SriCommandRegistration): void;
  registerTool(tool: SkillImproveToolDefinition): void;
  appendEntry(customType: string, data?: ImprovementEntry): void;
  sendMessage(message: SkillImproveMessage): void;
  on(event: "session_start", handler: SriSessionStartHandler): () => void;
}

// What pi loads and calls once per session. The parameter is pi's own ExtensionAPI, so what this
// package uses is proven against pi at the one call site that really runs: a member pi renames or
// retypes fails to compile on the line below instead of in a real session.
export default function sriExtension(pi: ExtensionAPI, seams: SriSeams = {}): void {
  const api: SriExtensionApi = pi;
  registerSurfaces(api, seams);
}

// The registration itself, over the slice. It is a separate function because pi's ExtensionAPI has
// fifty members a test here would have to stub and none of which it reads: a test drives this one
// with a five-member fake, and the assignment in sriExtension above is what keeps the slice honest.
export function registerSurfaces(api: SriExtensionApi, seams: SriSeams = {}): void {
  // OA8: a replay's child must not be able to start another loop over itself. The check is the first
  // statement of the registration and not a wrapper around the handlers, because a surface that is
  // never registered cannot be offered to the model either.
  if (isReplayChild()) return;

  // The dependencies both surfaces share, resolved once per extension instance: the flow's seams and the
  // gate's (absent in production, where the loop and the gate resolve each one) and the entry channel. Where a
  // run writes is not here: the base follows the agent directory the loop resolves itself, so the wiring holds
  // no path of the package's own.
  const deps: SkillImproveToolDeps = {
    ...seams,
    // The entry channel is the session record of an attempt and lives on the extension API, not on
    // the context a handler receives, so the wiring is the only place that can connect it.
    appendEntry: (customType, data) => {
      api.appendEntry(customType, data);
    },
  };

  // The command's own dependency: the message channel. With a UI the command notifies through
  // ctx.ui, and only a run without one needs this channel, which is why it is the command's and not
  // the tool's.
  //
  // It travels as a seam and not as a member of the context, because pi builds the context a handler
  // receives out of getters and documents that a spread both freezes them and skips its
  // active-instance check (dist/core/extensions/runner.js:724-728). Passing the context through
  // untouched is the only way to keep it live, so the wiring adds nothing to it.
  const commandDeps: SkillImproveDeps = {
    ...deps,
    sendMessage: (message) => {
      api.sendMessage(message);
    },
  };

  api.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      await runSkillImprove(args, ctx, commandDeps);
    },
  });

  api.registerTool(createSkillImproveTool(deps));

  // M1c (S11, Q26): the user and the model learn that the feedback of a session can be recorded from two channels that
  // cover the failure of the other -- a model reads the description of a tool and may never read a session notice, and a
  // user reads the notice and may never read a description. One line per session, and none on a reload (OA8): the notice
  // of a session pi reloaded after an acceptance would be the line the reader just read. Nothing behind the handler
  // reads a file, starts a process or holds a timer, so a session_start handler is all this costs.
  api.on("session_start", (event, ctx) => {
    if (event.reason === "reload") return;
    ctx.ui.notify(feedbackNoticeText(), "info");
  });
}

// The value src/gate/replay-runner.ts sets for its child (OA8). Only the exact string "1" disables
// the registration: anything else -- absent, empty, another value -- leaves the extension working,
// because an environment a caller did not mean to set must not silently remove these registrations.
function isReplayChild(): boolean {
  return process.env[REPLAY_ENV_VAR] === "1";
}
