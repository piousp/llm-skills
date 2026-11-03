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
} from "../src/command-skill-improve.ts";
import type { ImproveFlowContext, ImproveFlowDeps } from "../src/improve-flow.ts";
import { COMMAND_NAME } from "../src/names.ts";
import {
  createSkillImproveTool,
  skillImproveParams,
  type SkillImproveParams,
  type SkillImproveToolDeps,
  type ToolDetails,
} from "../src/tool-skill-improve.ts";

// The wiring (P10): the two surfaces of the loop registered on pi's extension API, and nothing else.
// Every decision this package makes lives in src/; this file decides only which surface is called
// and which dependencies it is called with.
//
//   /skill-improve <skill> [focus]         -> runSkillImprove (src/command-skill-improve.ts)
//   skill_improve { action, skill, focus } -> createSkillImproveTool (src/tool-skill-improve.ts)
//
// Both run the same loop (src/improve-flow.ts), so the command and the tool cannot disagree about
// what is eligible, what counts as evidence or what a candidate looks like. The tool receives its
// dependencies at registration time and the command receives the same ones at call time.
//
// What the factory does not do is as much part of the contract as what it does: no process, no
// socket, no timer, no file read (docs/extensions.md:58-60). The root below is path arithmetic; the
// settings, the inventory, the model, the writer and the clock are all resolved inside a run. That
// is also why M0 registers no session_start or session_shutdown handler: nothing here holds a
// resource that would need one.
//
// Importing this module runs nothing either. The only statements at module level declare types and
// constants, so a `pi -e` that loads the file and never calls the factory registers nothing.

// The description is what the command list shows, so it names the syntax and the one thing a user
// must know before running it: the skill is staged, never edited and never accepted.
const COMMAND_DESCRIPTION = `Stage a lesson candidate for one installed skill from the failures of this session: /${COMMAND_NAME} <skill> [focus]. It never edits the skill and never accepts a candidate.`;

// The seams a test may replace: everything the loop resolves for itself. No path travels through the
// wiring: the write base follows the agent directory, so the factory passes nothing of its own.
export type SriSeams = ImproveFlowDeps;

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

// The slice of ExtensionAPI this package uses: the two registrations, and the two channels that only
// the extension API carries (appendEntry and sendMessage do not exist on the context pi hands a
// handler or a tool). The session entry of this package is always the same payload, so appendEntry
// is narrowed to it here rather than at every call site.
export interface SriExtensionApi {
  registerCommand(name: string, options: SriCommandRegistration): void;
  registerTool(tool: SkillImproveToolDefinition): void;
  appendEntry(customType: string, data?: ImprovementEntry): void;
  sendMessage(message: SkillImproveMessage): void;
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
// with a four-member fake, and the assignment in sriExtension above is what keeps the slice honest.
export function registerSurfaces(api: SriExtensionApi, seams: SriSeams = {}): void {
  // The dependencies both surfaces share, resolved once per extension instance: the flow's seams
  // (absent in production, where the loop resolves each one) and the entry channel. Where a run writes
  // is not here: the base follows the agent directory the loop resolves itself, so the wiring holds no
  // path of the package's own.
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
}
