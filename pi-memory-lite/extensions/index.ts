// The entrypoint pi loads: the two events of the lifecycle, the settings read where the host allows it, and the four
// registrations. Nothing else lives here (§13): no SQL, no budget arithmetic, no formatting, no parsing of the settings
// by hand — `resolveConfig` reads them, `createMemoryTools` decides what a call does, `src/render.ts` decides how a row
// looks, and this file decides only when each of them is called.
//
// The load is the constraint that shapes the whole file. `pi.getSettings()` and `pi.getAllTools()` throw while the
// extensions load (§7.6, D16), so both are read inside `session_start` and the factory itself touches neither, registers
// no tool and opens no database. The connection follows the first tool call (§8.3) and is closed on `session_shutdown`;
// the memo of the open lives here, in the instance, because the shutdown handler and the tools of a session have to hold
// the same handle.
//
// The host surface is narrowed to the slice this package uses, the way the sibling packages do it: the default export
// takes pi's own `ExtensionAPI` and assigns it to the slice once, so the compile time proof that the slice still fits pi
// sits on a single line, and the registration itself takes the slice — which is what lets a test drive it with the six
// members it declares.

import { getAgentDir, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkNodeVersion, resolveConfig } from "../src/config.ts";
import { openStore, messageOf, type MemoryStore } from "../src/db.ts";
import { appendUnique } from "../src/query.ts";
import { createMemoryRenderers } from "../src/render.ts";
import { MEMORY_TOOL_NAMES, createMemoryTools } from "../src/tools.ts";

/** Prefix of every line this package logs and, with it, every notice it shows: one string to search for. */
const PREFIX = "[pi-memory-lite]";

/** What a tool listing says when it does not say which file registered the tool. */
const UNKNOWN_SOURCE = "an unknown source";

/**
 * The seams a test may replace: the environment, the Node version, the agent directory, the open of the store and the
 * clock. All of them are resolved at factory time and none of them does I/O, so a test can run the whole lifecycle with
 * no settings file, no real memory and no wait.
 */
export interface MemoryLiteSeams {
  /** `process.env`, which decides the directory override of §7.6. */
  readonly env?: Record<string, string | undefined>;
  /** `process.versions.node`, the version the guard of §8.2 reads. */
  readonly nodeVersion?: string;
  /** `getAgentDir()`, the base of the default data directory. A function, so calling it stays inside the session. */
  readonly agentDir?: () => string;
  /** `openStore` of `src/db.ts`: the lazy open, replaced by a counter in the tests of the lifecycle. */
  readonly openStore?: (options: { dir: string }) => Promise<MemoryStore>;
  /** The clock of a write. */
  readonly now?: () => Date;
}

/** The slice of a tool listing the collision check reads: the name and the file that registered it (§12). */
export interface MemoryLiteToolInfo {
  readonly name: string;
  readonly sourceInfo?: { readonly path?: string };
}

/**
 * The declaration as the host takes it. The tools of `createMemoryTools` carry their own parameter and details types,
 * and the renderers are merged in after them, so the registration is typed by the host's own `ToolDefinition` rather
 * than by a second copy of its shape.
 */
export type MemoryLiteToolDeclaration = ToolDefinition;

/** The one member of the context's UI this package uses: the notice a warning reaches the user through. */
export interface MemoryLiteNoticeContext {
  readonly ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

/** The `session_start` handler of §7.6: settings, the guard, the registration and the warnings, all inside its try. */
export type MemoryLiteSessionStartHandler = (
  event: { readonly type: "session_start" },
  ctx: MemoryLiteNoticeContext,
) => void | Promise<void>;

/** The `session_shutdown` handler of §8.3: it closes the connection and reads no context. */
export type MemoryLiteSessionShutdownHandler = () => void | Promise<void>;

/** The slice of `ExtensionAPI` this package uses. pi's own type satisfies it at the assignment in the factory. */
export interface MemoryLiteExtensionApi {
  on(event: "session_start", handler: MemoryLiteSessionStartHandler): () => void;
  on(event: "session_shutdown", handler: MemoryLiteSessionShutdownHandler): () => void;
  registerTool(tool: MemoryLiteToolDeclaration): void;
  getSettings(): unknown;
  getAllTools(): readonly MemoryLiteToolInfo[];
}

/**
 * What pi loads and calls once per extension load. It takes pi's own `ExtensionAPI` and narrows it to the slice once, so
 * a member the host renames or retypes fails to compile here instead of in a real session, and a test can drive the
 * registration with the six members the slice declares.
 */
export default function memoryLiteExtension(pi: ExtensionAPI, seams: MemoryLiteSeams = {}): void {
  const api: MemoryLiteExtensionApi = pi;
  registerMemoryLite(api, seams);
}

/**
 * The registration itself, over the slice: synchronous and free of I/O. It resolves the seams, subscribes to the two
 * events of the lifecycle and returns. Subscribing is allowed during the load; reading the settings, listing the tools
 * and registering a tool are not, and none of the three happens before `session_start` fires.
 */
export function registerMemoryLite(api: MemoryLiteExtensionApi, seams: MemoryLiteSeams = {}): void {
  const env = seams.env ?? process.env;
  const nodeVersion = seams.nodeVersion ?? process.versions.node;
  const agentDir = seams.agentDir ?? getAgentDir;
  const openAt = seams.openStore ?? openStore;
  const now = seams.now ?? ((): Date => new Date());

  /** The open of this instance, memoized: the tools of the session and the shutdown handler share this one promise. */
  let storePromise: Promise<MemoryStore> | undefined;

  /** Whether this instance has already registered its four tools, which is what keeps a second `session_start` silent. */
  let registered = false;

  /**
   * The getter the tools of one session receive. The memo lives in the instance and not in the getter, so the shutdown
   * handler can await the same promise the tools got; a failed open clears it, so the next call tries again instead of
   * answering every call of the session with the same rejection.
   */
  function storeGetterOf(dir: string): () => Promise<MemoryStore> {
    return () => {
      if (storePromise === undefined) {
        storePromise = openAt({ dir }).catch((error: unknown) => {
          storePromise = undefined;
          throw error;
        });
      }
      return storePromise;
    };
  }

  api.on("session_start", async (_event, ctx) => {
    try {
      // §7.6: the settings are read here and never at load, and `resolveConfig` never throws on what a user typed.
      const raw = api.getSettings() as unknown as Record<string, unknown>;
      const { config, warnings } = resolveConfig({ raw, env, agentDir: agentDir() });
      const support = checkNodeVersion(nodeVersion);

      if (registered) return;
      registered = true;

      const tools = createMemoryTools({
        store: storeGetterOf(config.dir),
        config,
        now,
        unsupported: support.ok ? undefined : support.message,
      });

      // The name of a declaration is a `string` once the host's `defineTool` has widened it, and the renderers are typed
      // by the four names of the contract. The position is that name: the tuple is built in `MEMORY_TOOL_NAMES` order.
      for (const [index, tool] of tools.entries()) {
        api.registerTool({ ...tool, ...createMemoryRenderers(MEMORY_TOOL_NAMES[index]) });
      }

      // §12: the names are prefixed, and a second extension that registered one of them is worth a line. The listing is
      // read after the registration, so this instance's own four are part of what the paths are compared against.
      const collision = collisionWarning(api.getAllTools());
      if (collision !== undefined) warn(ctx, collision);

      // The settings warnings and the guard of §8.2 reach the user through the UI and the developer through the log.
      for (const warning of [...warnings, ...(support.ok ? [] : [support.message])]) warn(ctx, warning);
    } catch (error) {
      // A session that cannot read its settings is still a session: it runs without memory and says why, once.
      ctx.ui.notify(`${PREFIX} ${messageOf(error)}`, "error");
    }
  });

  api.on("session_shutdown", async () => {
    const pending = storePromise;
    if (pending === undefined) return;

    // Cleared before the await: a call that lands while the handle is closing has to open a new one, because a closed
    // handle must never be handed out again.
    storePromise = undefined;

    const store = await pending.catch(() => undefined);
    store?.close();
  });
}

/**
 * The warning of a name that more than one source owns (§12). The four names of this package are read from the listing,
 * every source path behind them collected, and a second path means another extension registered memory tools too: the
 * two installations would answer the same call, and only one of them would be the one the user meant. The names go in
 * front of the sources so the sentence reads the same with one name and with several.
 */
function collisionWarning(tools: readonly MemoryLiteToolInfo[]): string | undefined {
  const names: string[] = [];
  const sources = new Set<string>();

  for (const tool of tools) {
    if (!isMemoryToolName(tool.name)) continue;
    appendUnique(names, tool.name);
    sources.add(tool.sourceInfo?.path ?? UNKNOWN_SOURCE);
  }

  if (sources.size < 2) return undefined;

  return `The memory tool names registered from more than one source are ${names.join(", ")} (${[...sources].join(", ")}); another extension may register the same tools.`;
}

/** Whether a tool name is one of the four of this package, which is the set §12 watches for collisions. */
function isMemoryToolName(name: string): boolean {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

/** One warning on both channels: the line a developer reads in the log and the notice a user reads in the session. */
function warn(ctx: MemoryLiteNoticeContext, message: string): void {
  console.warn(`${PREFIX} ${message}`);
  ctx.ui.notify(message, "warning");
}
