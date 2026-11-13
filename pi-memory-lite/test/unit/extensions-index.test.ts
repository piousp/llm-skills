import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { AgentToolResult, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import {
  registerMemoryLite,
  type MemoryLiteBeforeAgentStartHandler,
  type MemoryLiteExtensionApi,
  type MemoryLiteNoticeContext,
  type MemoryLiteSeams,
  type MemoryLiteSessionShutdownHandler,
  type MemoryLiteSessionStartHandler,
  type MemoryLiteToolDeclaration,
  type MemoryLiteToolInfo,
} from "../../extensions/index.ts";
import { SETTINGS_KEY, resolveConfig } from "../../src/config.ts";
import { openStore, type MemoryStore } from "../../src/db.ts";
import { buildCallLine, buildResultRender } from "../../src/render.ts";
import { MEMORY_TOOL_NAMES } from "../../src/tools.ts";

// The wiring, driven the way pi drives it: a fake extension API that records what the factory registers, the three events
// fired by hand, and the seams of the entrypoint replaced so no test reads a real settings file, opens the user's memory
// or waits on a clock. The fake is typed as the slice the registration declares (`MemoryLiteExtensionApi`), which is
// what lets it be six members and not pi's whole `ExtensionAPI`; the default export takes pi's own type and narrows it,
// and that assignment is the compile-time proof that the slice still fits.
//
// Three of the fake's members throw until the test enables them (`getSettings`, `getAllTools`, `registerTool`), the way
// the host answers during extension loading (§7.6). A read or a registration at factory time therefore surfaces as a
// failure here instead of passing quietly: the call is recorded before it throws, so the assertion can name it.
//
// The renderers of `src/render.ts` are covered at the end of the file, through the pure builders and not through the
// `Text` components: the exact line of each state is the contract, and a component would only add a width to it.

/** The clock of every fixture, so a stored timestamp is a constant of the suite. */
const NOW = "2026-03-14T09:26:53.589Z";

/** The path the fake host reports for the tools this extension registers. */
const OUR_SOURCE = "/agent/extensions/pi-memory-lite/index.ts";

/** A second path: what the listing shows when another extension registered a memory tool. */
const OTHER_SOURCE = "/agent/extensions/pi-other-memory/index.ts";

/** A Node version that passes the guard of §8.2, pinned so the suite does not depend on the binary running it. */
const HEALTHY_NODE = "24.19.0";

/**
 * The tag of the section the entrypoint owns in the host's prompt, spelled out here: the name is part of the contract
 * with the host — namespaced so it cannot collide with another extension's section — and a test that imported it would
 * pass with whatever the module decided to call it.
 */
const MEMORY_SECTION = "memory_lite";

/** A temporary directory the test removes afterwards, never a fixed one shared between tests. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(realpathSync(os.tmpdir()), "pi-memory-lite-ext-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A settings object with one block of this package, the shape `pi.getSettings()` returns. */
function settings(block: Record<string, unknown>): Record<string, unknown> {
  return { [SETTINGS_KEY]: block };
}

/** The seams of a healthy session over `dir`: no environment, a Node that passes the guard, and the fixed clock. */
function seamsFor(dir: string, overrides: MemoryLiteSeams = {}): MemoryLiteSeams {
  return { env: {}, agentDir: () => dir, nodeVersion: HEALTHY_NODE, now: () => new Date(NOW), ...overrides };
}

/**
 * The ten fields of `NormalizedBuildSystemPromptOptions`, all of them present: the host hands the handler a complete
 * shape, and a tidier fixture would pass while the real one carried a field the section depends on.
 */
function promptOptions(
  overrides: Partial<NormalizedBuildSystemPromptOptions> = {},
): NormalizedBuildSystemPromptOptions {
  return {
    cwd: "/home/test/project",
    selectedTools: [...MEMORY_TOOL_NAMES],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    contextFiles: [],
    skills: [],
    ...overrides,
  };
}

/** One notice the fake UI received. */
interface Notified {
  readonly message: string;
  readonly type: string | undefined;
}

interface HostOptions {
  /** What `getSettings()` returns once the session has started. */
  readonly settings?: unknown;
  /** What `getAllTools()` reports besides the tools this instance registers, which is where a collision comes from. */
  readonly tools?: readonly MemoryLiteToolInfo[];
  /**
   * The names the session registry holds, when a test pins them instead of letting the listing answer what the
   * registration recorded. It is the state a `-t` allowlist leaves: the tools this instance registered are not there.
   */
  readonly registry?: readonly string[];
  /**
   * The ordinal of the `registerTool` call that throws, counted from one, for the session whose registration fails in the
   * middle of the loop: the fake host answers the third registration the way pi answers a name it refuses.
   */
  readonly failRegisterAt?: number;
}

interface Host {
  readonly pi: MemoryLiteExtensionApi;
  /** Every tool the factory registered, in the order it registered them. */
  readonly registered: MemoryLiteToolDeclaration[];
  /** Every notice the handlers sent to `ctx.ui`. */
  readonly notified: Notified[];
  /** Every session-only member that was called, in order: empty until a session starts. */
  readonly calls: string[];
  /** Every event the factory subscribed to, in order. */
  readonly events: string[];
  /** Turns the three session-only members on; before this every call to one of them throws, as the host does at load. */
  enable(): void;
  /** Fires `session_start` with the fake context, which is what pi does once the load is over. */
  start(): Promise<void>;
  /**
   * Fires `before_agent_start` over the options built from the overrides, and hands those options back once the handler
   * has run: a section is a mutation of `sections`, so the assertion has to read the object the handler received.
   */
  agentStart(overrides?: Partial<NormalizedBuildSystemPromptOptions>): Promise<NormalizedBuildSystemPromptOptions>;
  /** Fires `session_shutdown`. */
  shutdown(): Promise<void>;
}

/**
 * The fake host: the four members `MemoryLiteExtensionApi` declares plus the recorders the assertions read. The three
 * session-only members throw while the host is not enabled, so a call made at factory time is both recorded and loud.
 */
function makeHost(options: HostOptions = {}): Host {
  const registered: MemoryLiteToolDeclaration[] = [];
  const notified: Notified[] = [];
  const calls: string[] = [];
  const events: string[] = [];
  const handlers = new Map<string, unknown>();
  let enabled = false;

  const ctx: MemoryLiteNoticeContext = {
    ui: {
      notify(message, type) {
        notified.push({ message, type });
      },
    },
  };

  /** Records the call and refuses it while the load is still running: `pi.getSettings()` throws exactly like this. */
  function guard(member: string): void {
    calls.push(member);
    if (!enabled) throw new Error(`pi.${member} no está disponible durante la carga de la extensión`);
  }

  const pi: MemoryLiteExtensionApi = {
    // Annotated by hand and not inferred: with an overload set TypeScript stops contextually typing the parameters of a
    // literal, and a handler recorded as `never` could not be called back by the tests.
    on(event: string, handler: unknown) {
      events.push(event);
      handlers.set(event, handler);
      return () => undefined;
    },
    registerTool(tool) {
      guard("registerTool");
      if (options.failRegisterAt !== undefined && registered.length + 1 === options.failRegisterAt) {
        throw new Error(`pi.registerTool rechazó ${tool.name} en la llamada ${options.failRegisterAt}`);
      }
      registered.push(tool);
    },
    getSettings() {
      guard("getSettings");
      return options.settings ?? {};
    },
    getAllTools() {
      guard("getAllTools");
      // A test that pins the registry gets exactly the names it pinned: that is what a `-t` allowlist leaves, a listing
      // without the tools this instance registered. Otherwise the listing pi answers after the registration: the seeded
      // tools of other extensions plus this instance's own, each one labelled with the file that registered it.
      if (options.registry !== undefined) return options.registry.map((name) => ({ name }));
      const own = registered.map((tool) => ({ name: tool.name, sourceInfo: { path: OUR_SOURCE } }));
      return [...(options.tools ?? []), ...own];
    },
  };

  function startHandler(): MemoryLiteSessionStartHandler {
    const handler = handlers.get("session_start");
    assert.ok(handler !== undefined, "el factory tiene que suscribirse a session_start");
    return handler as MemoryLiteSessionStartHandler;
  }

  function shutdownHandler(): MemoryLiteSessionShutdownHandler {
    const handler = handlers.get("session_shutdown");
    assert.ok(handler !== undefined, "el factory tiene que suscribirse a session_shutdown");
    return handler as MemoryLiteSessionShutdownHandler;
  }

  function beforeAgentStartHandler(): MemoryLiteBeforeAgentStartHandler {
    const handler = handlers.get("before_agent_start");
    assert.ok(handler !== undefined, "el factory tiene que suscribirse a before_agent_start");
    return handler as MemoryLiteBeforeAgentStartHandler;
  }

  return {
    pi,
    registered,
    notified,
    calls,
    events,
    enable() {
      enabled = true;
    },
    async start() {
      await startHandler()({ type: "session_start" }, ctx);
    },
    async agentStart(overrides = {}) {
      const options = promptOptions(overrides);
      await beforeAgentStartHandler()(
        { type: "before_agent_start", messageType: "user", prompt: "hola", systemPrompt: "", systemPromptOptions: options },
        ctx,
      );
      return options;
    },
    async shutdown() {
      await shutdownHandler()();
    },
  };
}

/** The count of opens and closes of the stores a test builds through `realOpen`. */
interface OpenLog {
  opens: number;
  closes: number;
}

/**
 * The real store of `src/db.ts` over the resolved directory, wrapped so the test can count the opens and the closes and
 * the store still closes the file it opened. The wrapper is what turns the lazy open of §8.3 into an observable fact.
 */
function realOpen(log: OpenLog): (options: { dir: string }) => Promise<MemoryStore> {
  return async (options) => {
    const store = await openStore({ dir: options.dir });
    log.opens += 1;
    return {
      ...store,
      close: () => {
        log.closes += 1;
        store.close();
      },
    };
  };
}

/** Calls the `execute` of a registered declaration, which is the only path a tool call takes into the wiring. */
async function executeTool(tool: MemoryLiteToolDeclaration, params: unknown): Promise<AgentToolResult<unknown>> {
  return tool.execute("call-1", params as never, undefined, undefined, undefined as never);
}

/** The declaration of one tool by name, for a test that calls it. */
function toolNamed(host: Host, name: string): MemoryLiteToolDeclaration {
  const tool = host.registered.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `el factory tiene que registrar ${name}`);
  return tool;
}

/** The text the model reads, which is where an error result carries its message. */
function textOf(result: AgentToolResult<unknown>): string {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

/** Every message the fake console received, as one string per call, for the assertions on `console.warn`. */
function consoleWarnings(mock: { mock: { calls: readonly { arguments: readonly unknown[] }[] } }): string[] {
  return mock.mock.calls.map((call) => call.arguments.map((argument) => String(argument)).join(" "));
}

/**
 * The collision sentence as §12 writes it, spelled out and not matched by a fragment: the wording is the contract of the
 * notice, so the test names the whole line. The names are every memory name the listing holds — the own four and any
 * seeded one — in the listing order, and the sources are the paths that registered them.
 */
function collisionSentence(names: readonly string[], sources: readonly string[]): string {
  return `The memory tool names registered from more than one source are ${names.join(", ")} (${sources.join(", ")}); another extension may register the same tools.`;
}

// --- la carga -------------------------------------------------------------------------------------------------------

// §7.6 / D16: the factory runs during the load and may not read the settings, list the tools or register one. The fake's
// three members throw until enabled, and each call is recorded before it throws, so a read at load time fails here with
// the name of the member instead of passing unnoticed.
test("factory: no lee settings, no lista las tools y no registra nada durante la carga", (t) => {
  const dir = tempDir(t);
  const host = makeHost();

  assert.doesNotThrow(() => registerMemoryLite(host.pi, seamsFor(dir)));

  assert.deepEqual(host.calls, [], "el factory no puede llamar a getSettings, getAllTools ni registerTool durante la carga");
  assert.deepEqual(host.registered, [], "el factory no puede registrar tools durante la carga");
  assert.deepEqual(
    host.events,
    ["session_start", "session_shutdown", "before_agent_start"],
    "el factory se suscribe a los tres eventos y a ninguno más",
  );
  assert.equal(host.notified.length, 0);
});

// The whole body of the handler is inside its try: a session whose getSettings still fails is a session without memory,
// not a session broken by the extension. The fake is deliberately left disabled, which is exactly the host's state during
// the load.
test("session_start: un fallo del handler no escapa y se avisa como error", async (t) => {
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));

  await assert.doesNotReject(() => host.start());

  const notice = host.notified.find((candidate) => candidate.type === "error");
  assert.ok(notice !== undefined, `el fallo tiene que llegar a ctx.ui.notify como error; llegó: ${JSON.stringify(host.notified)}`);
  assert.ok(notice.message.startsWith("[pi-memory-lite] "), `el aviso de error lleva el prefijo; llegó: ${notice.message}`);
  assert.deepEqual(host.registered, [], "un handler que falló no puede haber registrado tools");
});

// §7 and §8.6: the four tools, in the order of the contract, each one carrying what makes it budget (criterion 2) and
// what makes it drawable (the two renderers of src/render.ts). A tool that skipped its snippet would silently leave the
// `<tools>` section, and one that skipped a renderer would fall back to the host's generic row.
test("session_start: registra las cuatro tools en orden, con snippet, anotaciones y renderers", async (t) => {
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  assert.deepEqual(
    host.registered.map((tool) => tool.name),
    [...MEMORY_TOOL_NAMES],
  );

  for (const tool of host.registered) {
    assert.ok(tool.description.length > 0, `${tool.name} necesita una descripción`);
    assert.ok((tool.promptSnippet ?? "").length > 0, `${tool.name} necesita promptSnippet para entrar en <tools>`);
    assert.equal(typeof tool.annotations, "object", `${tool.name} necesita anotaciones`);
    assert.equal(typeof tool.renderCall, "function", `${tool.name} necesita renderCall`);
    assert.equal(typeof tool.renderResult, "function", `${tool.name} necesita renderResult`);
  }
});

// The `registered` flag: pi can fire session_start more than once for the same instance, and a second registration would
// collide with the first on every name.
test("session_start: dos disparos sobre la misma instancia no duplican el registro", async (t) => {
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();

  await host.start();
  await host.start();

  assert.equal(host.registered.length, 4);
  assert.equal(
    host.calls.filter((call) => call === "registerTool").length,
    4,
    "registerTool tiene que llamarse cuatro veces en total, no ocho",
  );
});

// A reload is a new instance of the factory, which has its own flag: the session that follows the shutdown has to get
// its tools again, or the package would answer no call after the first reload.
test("session_shutdown y una instancia nueva: el registro vuelve a ocurrir", async (t) => {
  const dir = tempDir(t);

  const first = makeHost();
  registerMemoryLite(first.pi, seamsFor(dir));
  first.enable();
  await first.start();
  await first.shutdown();

  const second = makeHost();
  registerMemoryLite(second.pi, seamsFor(dir));
  second.enable();
  await second.start();

  assert.equal(first.registered.length, 4);
  assert.equal(second.registered.length, 4, "una instancia nueva tiene que registrar las cuatro tools otra vez");
});

// --- exposición -----------------------------------------------------------------------------------------------------

// §8.6 / D9: `exposure` comes from the settings resolved inside session_start, and the three values reach all four tools.
test("exposure: los tres valores de settings llegan a las cuatro tools", async (t) => {
  for (const exposure of ["direct", "codemode", "deferred"] as const) {
    const dir = tempDir(t);
    const host = makeHost({ settings: settings({ exposure }) });
    registerMemoryLite(host.pi, seamsFor(dir));
    host.enable();
    await host.start();

    assert.deepEqual(
      host.registered.map((tool) => tool.exposure),
      [exposure, exposure, exposure, exposure],
      `exposure "${exposure}" no llegó a las cuatro declaraciones`,
    );
  }
});

// --- la sección del prompt -------------------------------------------------------------------------------------------

// With the default exposure the four declarations are in the prompt and the section has nothing to add: the handler has
// to leave the options exactly as it found them — the map it received, and every other field of the turn's options. The
// snapshot is built before the handler runs, with all ten fields, so a write to `selectedTools`, `hiddenTools` or
// `toolSnippets` fails here and not only a write to `sections`.
test("prompt: en direct las cuatro declaradas dejan el prompt sin sección", async (t) => {
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  const sections = { tools: "<tools>\n- memory_write: guarda un dato\n</tools>" };
  const snapshot = promptOptions({ selectedTools: ["read", "bash", ...MEMORY_TOOL_NAMES], sections });
  const options = await host.agentStart({ selectedTools: ["read", "bash", ...MEMORY_TOOL_NAMES], sections });

  assert.equal(options.sections, sections, "el handler no puede reemplazar el mapa de secciones");
  assert.deepEqual(
    sections,
    { tools: "<tools>\n- memory_write: guarda un dato\n</tools>" },
    `la sección apareció con las cuatro declaradas; llegó: ${JSON.stringify(sections)}`,
  );
  assert.deepEqual(options, snapshot, "el handler no puede escribir en ninguna otra parte de las opciones del turno");
  assert.deepEqual(host.notified, [], "con las cuatro declaradas no hay nada que avisar");
});

// `deferred` keeps the four out of the prompt and an active `tool_search` is the mechanism that reaches them: the section
// names it, costs one key and one patch, and fits under the character ceiling. The exposure has to be one of the two that
// took the declarations away; with `direct` the section would name the script instead, because `tool_search` indexes only
// non-`direct` tools. The fake host's registry mirrors what this instance registered, which is the session whose allowlist
// did name the four — the opposite state of the case right below this one.
test("prompt: con tool_search y sin las tools la sección llega al prompt", async (t) => {
  const dir = tempDir(t);
  const host = makeHost({ settings: settings({ exposure: "deferred" }) });
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  const options = await host.agentStart({ selectedTools: ["read", "bash", "tool_search"] });

  const section = options.sections[MEMORY_SECTION];
  assert.ok(section !== undefined, `la sección tiene que llegar al prompt; llegó: ${JSON.stringify(options.sections)}`);
  assert.deepEqual(Object.keys(options.sections), [MEMORY_SECTION], "la sección agrega una sola clave");
  assert.equal(section.includes("tool_search"), true, "la sección tiene que nombrar tool_search");
  assert.equal(section.includes("\n"), false, "la sección es un párrafo y no lleva saltos de línea");
  assert.ok(section.length <= 360, `la sección no puede pasar 360 caracteres; llegó: ${section.length}`);
  assert.deepEqual(host.notified, [], "con un mecanismo que las alcanza no hay aviso");
});

// The other half of the same question: the model is told to search only when the registry holds the four tools. A `-t`
// allowlist that leaves them out removes them from the session, so `tool_search` could never return one — the section has to
// say they are unreachable and name the allowlist among the ways out, even with `tool_search` declared and `deferred` set.
test("prompt: una allowlist que filtra las tools lleva a la sección inalcanzable", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const dir = tempDir(t);
  const host = makeHost({
    settings: settings({ exposure: "deferred" }),
    registry: ["read", "bash", "tool_search"],
  });
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  const options = await host.agentStart({ selectedTools: ["read", "bash", "tool_search"] });

  const section = options.sections[MEMORY_SECTION];
  assert.ok(section !== undefined, `la sección tiene que llegar al prompt; llegó: ${JSON.stringify(options.sections)}`);
  assert.deepEqual(Object.keys(options.sections), [MEMORY_SECTION], "la sección agrega una sola clave");
  assert.equal(section.includes("unreachable"), true, `sin las tools en el registro la sección dice que no se alcanzan; llegó: ${section}`);
  assert.equal(section.includes("tool_search; a match"), false, "no puede prometer una búsqueda que no puede devolverlas");
  assert.equal(section.includes("tools allowlist"), true, "la sección tiene que nombrar la allowlist entre las salidas");
  assert.ok(section.length <= 360, `la sección no puede pasar 360 caracteres; llegó: ${section.length}`);

  // Unreachable is the case the user has to fix, so it warns once per instance with the section's own words.
  const notices = host.notified.filter((notice) => notice.message === section);
  assert.equal(notices.length, 1, `el aviso sale una sola vez por instancia; llegó: ${JSON.stringify(host.notified)}`);
  assert.deepEqual(consoleWarnings(warn), [`[pi-memory-lite] ${section}`], "el log recibe la misma cadena que la sección");
});

// `codemode` is the other mechanism: the section names the script, which is the only way to call a tool the prompt does
// not declare. `tool_search` is declared here too and the section still names the script: with the default exposure that
// search cannot reach these tools, so promising it would be the lie this branch exists to avoid.
test("prompt: con codemode y sin las tools la sección llega al prompt", async (t) => {
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  const options = await host.agentStart({ selectedTools: ["read", "bash", "codemode", "tool_search"] });

  const section = options.sections[MEMORY_SECTION];
  assert.ok(section !== undefined, `la sección tiene que llegar al prompt; llegó: ${JSON.stringify(options.sections)}`);
  assert.deepEqual(Object.keys(options.sections), [MEMORY_SECTION], "la sección agrega una sola clave");
  assert.equal(section.includes("codemode"), true, "la sección tiene que nombrar codemode");
  assert.equal(section.includes("tool_search"), false, "con exposure direct la sección no puede prometer tool_search");
  assert.equal(section.includes("\n"), false, "la sección es un párrafo y no lleva saltos de línea");
  assert.ok(section.length <= 360, `la sección no puede pasar 360 caracteres; llegó: ${section.length}`);
  assert.deepEqual(host.notified, [], "con un mecanismo que las alcanza no hay aviso");
});

// With no mechanism the tools are unreachable, and that does not repair itself: the section says so in the prompt and the
// warning says it once on both channels, with the section's own string, so the model and the user never read two things.
test("prompt: sin mecanismo la sección llega y el aviso sale una sola vez", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  const first = await host.agentStart({ selectedTools: ["read", "bash"] });
  const section = first.sections[MEMORY_SECTION];
  assert.ok(section !== undefined, `la sección tiene que llegar al prompt; llegó: ${JSON.stringify(first.sections)}`);
  assert.deepEqual(Object.keys(first.sections), [MEMORY_SECTION], "la sección agrega una sola clave");
  assert.equal(section.includes("unreachable"), true, "sin mecanismo la sección dice que no se alcanzan");
  assert.equal(section.includes("\n"), false, "la sección es un párrafo y no lleva saltos de línea");
  assert.ok(section.length <= 360, `la sección no puede pasar 360 caracteres; llegó: ${section.length}`);

  // Second turn: the section is written again — every turn builds the prompt anew — and the warning is not repeated.
  const second = await host.agentStart({ selectedTools: ["read", "bash"] });
  assert.equal(second.sections[MEMORY_SECTION], section, "la sección se escribe en cada turno");

  const notices = host.notified.filter((notice) => notice.message === section);
  assert.equal(notices.length, 1, `el aviso sale una sola vez por instancia; llegó: ${JSON.stringify(host.notified)}`);
  assert.equal(notices[0]?.type, "warning");
  assert.deepEqual(
    consoleWarnings(warn),
    [`[pi-memory-lite] ${section}`],
    "el log recibe la misma cadena que la sección, una sola vez",
  );
});

// The exposure does not change mid-session, but the list of declared tools does: a `tool_search` that finds them declares
// them, and on the next turn the section has no reason to exist. The key is deleted, not written empty.
test("prompt: declarar las tools a mitad de sesión borra la sección", async (t) => {
  const dir = tempDir(t);
  const host = makeHost({ settings: settings({ exposure: "deferred" }) });
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  const selectedTools = ["read", "bash", "tool_search"];
  const first = await host.agentStart({ selectedTools });
  assert.ok(MEMORY_SECTION in first.sections, "el primer turno tiene que llevar la sección");

  selectedTools.push(...MEMORY_TOOL_NAMES);
  const second = await host.agentStart({ selectedTools });

  assert.equal(
    MEMORY_SECTION in second.sections,
    false,
    `la sección tiene que desaparecer; llegó: ${JSON.stringify(second.sections)}`,
  );
  assert.deepEqual(Object.keys(second.sections), [], "el turno que declara las tools no deja la clave vacía");
});

// A session that never registered its tools has nothing to say about them: the handler returns without touching the
// prompt and without a word, because the only fact it knows is that its own registration did not happen.
test("prompt: una sesión que no registró las tools no aporta sección", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  // No `enable()`: the session never started, which is the state in which `session_start` fails and registers nothing.

  const sections: Record<string, string> = {};
  const options = await host.agentStart({ selectedTools: ["read", "bash"], sections });

  assert.deepEqual(options.sections, {}, "sin registro el handler no escribe ninguna clave");
  assert.deepEqual(host.notified, [], "sin registro no hay aviso que dar");
  assert.deepEqual(consoleWarnings(warn), [], "sin registro no hay línea que registrar");
});

// The flag the prompt handler gates on means "the four tools exist", and not "the registration was attempted": a session
// whose `registerTool` threw halfway has two tools and no way to serve the other two, so the turn gets no section. The
// failed `session_start` already reported the error, and the handler adds nothing to it.
test("prompt: una sesión cuyo registro falló a la mitad no aporta sección", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const dir = tempDir(t);
  const host = makeHost({ failRegisterAt: 3 });
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  assert.equal(host.registered.length, 2, "el registro tiene que haberse cortado en la tercera llamada");
  const error = host.notified.find((notice) => notice.type === "error");
  assert.ok(error !== undefined, `el fallo del registro tiene que avisarse como error; llegó: ${JSON.stringify(host.notified)}`);

  const options = await host.agentStart({ selectedTools: ["read", "bash"] });

  assert.deepEqual(options.sections, {}, "una sesión con el registro a medias no escribe la sección");
  assert.equal(host.notified.length, 1, `el handler del prompt no puede agregar avisos; llegó: ${JSON.stringify(host.notified)}`);
  assert.deepEqual(consoleWarnings(warn), [], "el handler del prompt no puede agregar líneas al log");
});

// --- criterios 1 y 2 ------------------------------------------------------------------------------------------------

// Criterion 2 (§10): the permanent cost of the package, measured on the arguments `registerTool` received inside the
// handler — descriptions, snippets and serialized schemas — and never on a declaration built for the measurement.
test("criterio 2: descripciones, snippets y esquemas de las cuatro tools no pasan 1500 caracteres", async (t) => {
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  assert.equal(host.registered.length, 4);

  let total = 0;
  for (const tool of host.registered) {
    total += tool.description.length;
    total += (tool.promptSnippet ?? "").length;
    total += JSON.stringify(tool.parameters).length;
  }

  assert.ok(total <= 1500, `el presupuesto del criterio 2 se pasó: ${total} caracteres sobre 1500`);
});

// Criterion 1 (§10): with entries in the memory, the declarations the model sees are the same four and nothing of what
// the memory holds. The entry is written through the real store first, so the assertion is about a database with data.
test("criterio 1: ninguna declaración registrada contiene texto guardado en la memoria", async (t) => {
  const dir = tempDir(t);
  const text = "La receta del pan de sardinas es un secreto de la familia";
  const key = "sardinas";

  // El directorio sale de `resolveConfig` y no de una copia del defecto escrito a mano: la base que el test escribe y la
  // que la extensión abre tienen que ser la misma aunque el defecto cambie de nombre.
  const { config } = resolveConfig({ raw: {}, env: {}, agentDir: dir });
  const store = await openStore({ dir: config.dir });
  try {
    const written = store.write({ text, category: "general", keys: [key], ts: NOW });
    // The fixture has to be real: the entry is in the database before the session starts, so a declaration that named it
    // would be caught by the assertions below and not pass for lack of data.
    assert.equal(store.read([written.id]).found[0]?.text, text);
  } finally {
    store.close();
  }

  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  assert.equal(host.registered.length, 4);

  for (const tool of host.registered) {
    const declaration = JSON.stringify({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      parameters: tool.parameters,
      annotations: tool.annotations,
    });

    assert.equal(declaration.includes(text), false, `la declaración de ${tool.name} nombra el texto guardado`);
    assert.equal(declaration.includes(key), false, `la declaración de ${tool.name} nombra una key guardada`);
  }

  // La sección del prompt es la otra vía por la que el texto guardado podría llegar al modelo: se mide sobre lo que el
  // handler dejó en `sections`, con la memoria ya escrita.
  const options = await host.agentStart({ selectedTools: ["read", "bash", ...MEMORY_TOOL_NAMES] });
  const section = options.sections[MEMORY_SECTION] ?? "";
  assert.equal(section.includes(text), false, "la sección del prompt nombra el texto guardado");
  assert.equal(section.includes(key), false, "la sección del prompt nombra una key guardada");
});

// --- colisión, guarda de Node y ciclo de vida -----------------------------------------------------------------------

// §12: a second extension that registered one of the four names is worth a line, and the warning cannot stop the
// registration: the session keeps its own tools and the user decides which package to keep. The sentence is the
// contract, spelled out here down to the names and the two sources it puts between parentheses.
test("colisión: un memory_write de otra ruta avisa por console.warn y el registro termina igual", async (t) => {
  // The recorder replaces the real write: the assertion reads the calls and the suite stays quiet.
  const warn = t.mock.method(console, "warn", () => undefined);
  const dir = tempDir(t);
  const host = makeHost({ tools: [{ name: "memory_write", sourceInfo: { path: OTHER_SOURCE } }] });
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  assert.equal(host.registered.length, 4, "el aviso de colisión no puede impedir el registro");

  const sentence = collisionSentence([...MEMORY_TOOL_NAMES], [OTHER_SOURCE, OUR_SOURCE]);
  const messages = consoleWarnings(warn);
  assert.ok(
    messages.some((message) => message === `[pi-memory-lite] ${sentence}`),
    `se esperaba la sentencia de colisión; llegó: ${messages.join(" | ")}`,
  );

  assert.ok(
    host.notified.some((notice) => notice.message === sentence),
    "el aviso de colisión tiene que llegar también a ctx.ui.notify, sin el prefijo",
  );
});

// §12: con más de un nombre de otra ruta la sentencia los enumera en el orden del listado, y las dos rutas quedan entre
// paréntesis: la redacción nueva no depende de cuántos nombres nombra.
test("colisión: dos nombres de otra ruta aparecen los dos en la sentencia", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const dir = tempDir(t);
  const host = makeHost({
    tools: [
      { name: "memory_write", sourceInfo: { path: OTHER_SOURCE } },
      { name: "memory_search", sourceInfo: { path: OTHER_SOURCE } },
    ],
  });
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  const sentence = collisionSentence([...MEMORY_TOOL_NAMES], [OTHER_SOURCE, OUR_SOURCE]);
  assert.ok(
    host.notified.some((notice) => notice.message === sentence),
    `se esperaba la sentencia con los dos nombres; llegó: ${JSON.stringify(host.notified)}`,
  );
});

// §12: sin una segunda ruta no hay colisión que avisar, y un aviso que se disparara igual nombraria la instalación del
// propio usuario en cada sesión. Las dos canales tienen que quedar en silencio.
test("colisión: solo las cuatro tools propias no avisan por ninguno de los dos canales", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  assert.equal(host.registered.length, 4);

  const collision = /more than one source/;
  assert.equal(
    consoleWarnings(warn).some((message) => collision.test(message)),
    false,
    `console.warn no puede recibir la sentencia de colisión; llegó: ${consoleWarnings(warn).join(" | ")}`,
  );
  assert.equal(
    host.notified.some((notice) => collision.test(notice.message)),
    false,
    `ctx.ui.notify no puede recibir la sentencia de colisión; llegó: ${JSON.stringify(host.notified)}`,
  );
});

// §8.2 / criterion 13: a Node older than 22.14 loads, registers and answers every call with the requirement. The store
// is never opened, which is the point: the failure is a message and not a missing module.
test("guarda de Node: con 22.13.0 se registran las cuatro tools y memory_write responde el requisito sin abrir la base", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const log: OpenLog = { opens: 0, closes: 0 };
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir, { nodeVersion: "22.13.0", openStore: realOpen(log) }));
  host.enable();
  await host.start();

  assert.equal(host.registered.length, 4);
  assert.ok(
    host.notified.some((notice) => notice.message.includes("22.14")),
    "el aviso de versión tiene que llegar a ctx.ui.notify",
  );
  assert.ok(
    consoleWarnings(warn).some((message) => message.startsWith("[pi-memory-lite] ") && message.includes("22.14")),
    `el aviso de versión tiene que pasar por console.warn; llegó: ${consoleWarnings(warn).join(" | ")}`,
  );

  const result = await executeTool(toolNamed(host, "memory_write"), { text: "una nota", category: "general", keys: ["nota"] });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /22\.14/);
  assert.equal(log.opens, 0, "una tool que no puede abrir la base no puede llamar al getter del store");
});

// §8.3: the store opens on the first tool call and not before, and the second call reuses the connection instead of
// opening a second one over the same file.
test("lazy: el store se abre en la primera llamada y la segunda reusa el mismo", async (t) => {
  const log: OpenLog = { opens: 0, closes: 0 };
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir, { openStore: realOpen(log) }));
  host.enable();
  await host.start();

  assert.equal(log.opens, 0, "el registro de las tools no puede abrir la base");

  const read = toolNamed(host, "memory_read");
  await executeTool(read, { ids: [1] });
  assert.equal(log.opens, 1);

  await executeTool(read, { ids: [1] });
  assert.equal(log.opens, 1, "la segunda llamada tiene que reusar el store memoizado");

  await host.shutdown();
});

// §8.3: the memo of the open is cleared when it rejects, so a session that hit a transient failure — a locked file, a
// directory still being created — retries on the next call instead of answering the whole session with one rejection.
test("store: una apertura fallida limpia el memo y la llamada siguiente reintenta", async (t) => {
  let attempts = 0;
  const dir = tempDir(t);
  const opening = async (options: { dir: string }): Promise<MemoryStore> => {
    attempts += 1;
    if (attempts === 1) throw new Error("fallo de apertura simulado");
    return openStore({ dir: options.dir });
  };

  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir, { openStore: opening }));
  host.enable();
  await host.start();

  const read = toolNamed(host, "memory_read");
  const first = await executeTool(read, { ids: [1] });
  assert.equal(first.isError, true);
  assert.match(textOf(first), /fallo de apertura simulado/);

  const second = await executeTool(read, { ids: [1] });
  assert.equal(second.isError ?? false, false, "el segundo intento tiene que abrir la base y responder");
  assert.equal(attempts, 2, "el getter tiene que volver a pedir la apertura");

  await host.shutdown();
});

// §8.3: session_shutdown closes the handle. A call that arrives afterwards is answered by a new store, because the code
// reopens instead of handing out the closed handle — this test states which of the two branches the wiring implements.
test("shutdown: cierra el store y una ejecución posterior vuelve a pedir el getter en vez de recibir el store cerrado", async (t) => {
  const log: OpenLog = { opens: 0, closes: 0 };
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir, { openStore: realOpen(log) }));
  host.enable();
  await host.start();

  const read = toolNamed(host, "memory_read");
  await executeTool(read, { ids: [1] });
  assert.equal(log.opens, 1);

  await host.shutdown();
  assert.equal(log.closes, 1, "session_shutdown tiene que cerrar el store abierto");

  const later = await executeTool(read, { ids: [1] });
  assert.equal(log.opens, 2, "la ejecución posterior tiene que abrir un store nuevo");
  assert.equal(later.isError ?? false, false, "la ejecución posterior no puede fallar por el store cerrado");
  assert.match(textOf(later), /not found: 1/);

  await host.shutdown(); // closes the store the later call opened
  assert.equal(log.closes, 2);
});

// §8.3: a session that never called a tool has nothing to close, and a shutdown that tried anyway would be closing some
// other session's handle.
test("shutdown sin store abierto: es un no-op y no abre nada", async (t) => {
  const log: OpenLog = { opens: 0, closes: 0 };
  const dir = tempDir(t);
  const host = makeHost();
  registerMemoryLite(host.pi, seamsFor(dir, { openStore: realOpen(log) }));
  host.enable();
  await host.start();

  await assert.doesNotReject(() => host.shutdown());
  assert.deepEqual(log, { opens: 0, closes: 0 });
});

// --- avisos de settings ---------------------------------------------------------------------------------------------

// §7.6: an invalid setting degrades to the default with a warning, and the warning reaches the user. The registration
// still happens: a typo costs one option, not the session.
test("settings: una exposure inválida llega a ctx.ui.notify y a console.warn con el prefijo", async (t) => {
  // The recorder replaces the real write: the assertion reads the calls and the suite stays quiet.
  const warn = t.mock.method(console, "warn", () => undefined);
  const dir = tempDir(t);
  const host = makeHost({ settings: settings({ exposure: "nonsense" }) });
  registerMemoryLite(host.pi, seamsFor(dir));
  host.enable();
  await host.start();

  const notice = host.notified.find((candidate) => candidate.message.includes("nonsense"));
  assert.ok(notice !== undefined, `el aviso de exposure tiene que llegar a ctx.ui.notify; llegó: ${JSON.stringify(host.notified)}`);
  assert.equal(notice.type, "warning");
  assert.equal(host.registered.length, 4, "el aviso no puede impedir el registro");
  assert.deepEqual(
    host.registered.map((tool) => tool.exposure),
    ["direct", "direct", "direct", "direct"],
    "una exposure inválida tiene que degradar a direct",
  );

  const messages = consoleWarnings(warn);
  assert.ok(
    messages.some((message) => message.startsWith("[pi-memory-lite] ") && message.includes("nonsense")),
    `el aviso tiene que pasar por console.warn con el prefijo; llegó: ${messages.join(" | ")}`,
  );
});

// --- src/render.ts: las líneas colapsadas ---------------------------------------------------------------------------

test("render: la línea colapsada de cada llamada", () => {
  assert.equal(buildCallLine("memory_write", { text: "una nota", category: "env", keys: ["router"] }), "memory_write env");
  assert.equal(buildCallLine("memory_search", { query: "sushi" }), 'memory_search "sushi"');
  assert.equal(buildCallLine("memory_search", {}), "memory_search catalog");
  assert.equal(buildCallLine("memory_read", { ids: [3, 7] }), "memory_read #3, #7");
  assert.equal(buildCallLine("memory_delete", { ids: [1, 2, 3, 4, 5, 6] }), "memory_delete #1, #2, #3, #4, #5, …");
});

// La línea de una llamada de memory_search nombra el modo que el ejecutor va a contestar y no una segunda lectura de los
// mismos argumentos: un emoji no produce tokens, así que la tool contesta el catálogo y la línea dice catálogo; y
// count_only gana sobre los dos, porque el ejecutor lo mira antes de tokenizar la consulta.
test("render: la llamada de memory_search nombra el modo que el ejecutor va a contestar", () => {
  assert.equal(buildCallLine("memory_search", { query: "🎉" }), "memory_search catalog");
  assert.equal(buildCallLine("memory_search", { query: "  " }), "memory_search catalog");
  assert.equal(buildCallLine("memory_search", { query: "sushi", count_only: true }), "memory_search count");
  assert.equal(buildCallLine("memory_search", { count_only: true }), "memory_search count");
  // La consulta con tokens conserva su forma entre comillas, y el compuesto no se parte en el camino.
  assert.equal(buildCallLine("memory_search", { query: "sola-scriptura" }), 'memory_search "sola-scriptura"');
});

test("render: una llamada sin argumentos o con una forma rara muestra el nombre y no lanza", () => {
  assert.equal(buildCallLine("memory_write", {}), "memory_write");
  assert.equal(buildCallLine("memory_write", undefined), "memory_write");
  assert.equal(buildCallLine("memory_read", { ids: "no-es-un-arreglo" }), "memory_read");
  assert.equal(buildCallLine("memory_search", "basura"), "memory_search catalog");
});

test("render: la línea colapsada de memory_write", () => {
  assert.equal(
    buildResultRender("memory_write", { details: { id: 4, duplicate: false, category: "env" } }, { expanded: false })
      .text,
    "memory_write env #4",
  );
  assert.equal(
    buildResultRender("memory_write", { details: { id: 4, duplicate: true, category: "env" } }, { expanded: false })
      .text,
    "memory_write env #4 (duplicate)",
  );
});

test("render: la línea colapsada de los tres modos de memory_search", () => {
  const search = { mode: "search", total: 12, shown: 5, omitted: 7, offset: 0, ids: [31, 34] };
  const catalog = { mode: "catalog", total: 3, shown: 3, omitted: 0, offset: 0, ids: [] };
  // El conteo no tiene página ni ids: su details no los declara, y la línea tampoco los lee.
  const count = { mode: "count", total: 42, shown: 0, omitted: 0 };

  assert.equal(
    buildResultRender("memory_search", { details: search }, { expanded: false, args: { query: "sushi" } }).text,
    'memory_search "sushi" 5 of 12',
  );
  assert.equal(
    buildResultRender("memory_search", { details: catalog }, { expanded: false }).text,
    "memory_search catalog 3 categories",
  );
  assert.equal(
    buildResultRender("memory_search", { details: count }, { expanded: false }).text,
    "memory_search count 42",
  );
  // The query lives in the call arguments and not in `details`: without them the page is rendered without inventing one.
  assert.equal(
    buildResultRender("memory_search", { details: search }, { expanded: false }).text,
    "memory_search 5 of 12",
  );
});

test("render: la línea colapsada de memory_read y de memory_delete", () => {
  assert.equal(
    buildResultRender("memory_read", { details: { found: [3], missing: [7], shown: 1, omitted: 0 } }, { expanded: false })
      .text,
    "memory_read #3, #7 → 1 found, 1 missing",
  );
  assert.equal(
    buildResultRender("memory_delete", { details: { deleted: [1, 2], missing: [9] } }, { expanded: false }).text,
    "memory_delete 2 deleted, 1 missing",
  );
});

test("render: la línea de error toma la primera línea del mensaje", () => {
  assert.equal(
    buildResultRender("memory_read", { details: { error: "no such table\nat src/db.ts:1" } }, { expanded: false }).text,
    "Error: no such table",
  );
  assert.equal(
    buildResultRender("memory_delete", { details: { error: "boom" } }, { expanded: false }).text,
    "Error: boom",
  );
  // El error gana sobre la forma del details: la línea no depende de que la tool sea la que lo escribió.
  assert.equal(buildResultRender("memory_search", { details: { error: "boom" } }, { expanded: false }).text, "Error: boom");
  assert.equal(buildResultRender("memory_read", { details: { error: 42 } }, { expanded: false }).text, "Error: 42");
});

// Un details que no tiene la forma que la tool escribe no es un error: la fila cae a la línea pendiente, que es lo que
// ya muestra una llamada en curso, en vez de lanzar o de inventar una línea a partir de un campo que no está.
test("render: unos detalles con la forma equivocada caen a la línea pendiente", () => {
  assert.equal(buildResultRender("memory_write", { details: {} }, { expanded: false }).text, "memory_write …");
  assert.equal(
    buildResultRender("memory_search", { details: { mode: "nonsense" } }, { expanded: false }).text,
    "memory_search …",
  );
  assert.equal(buildResultRender("memory_read", { details: {} }, { expanded: false }).text, "memory_read …");
  assert.equal(
    buildResultRender("memory_delete", { details: { deleted: "no-es-un-arreglo" } }, { expanded: false }).text,
    "memory_delete …",
  );
});

test("render: un resultado sin detalles todavía muestra el nombre y la elipsis", () => {
  assert.equal(buildResultRender("memory_read", {}, { expanded: false }).text, "memory_read …");
  assert.equal(
    buildResultRender("memory_write", { details: undefined }, { expanded: false }).text,
    "memory_write …",
  );
  assert.equal(buildResultRender("memory_search", undefined, { expanded: false }).text, "memory_search …");
});

// The expanded row is the text the model read, as is: a reader who expands a result is asking for the payload and not
// for a prettier version of it.
test("render: expandido devuelve el texto del contenido tal cual", () => {
  const result = {
    content: [{ type: "text", text: "Saved #7 (env)." }],
    details: { id: 7, duplicate: false, category: "env" },
  };

  assert.equal(buildResultRender("memory_write", result, { expanded: true }).text, "Saved #7 (env).");
  assert.equal(buildResultRender("memory_write", result, { expanded: false }).text, "memory_write env #7");

  const failed = {
    content: [{ type: "text", text: "The text is 1801 characters and the maximum is 1800." }],
    details: { error: "The text is 1801 characters and the maximum is 1800." },
  };
  assert.equal(buildResultRender("memory_write", failed, { expanded: true }).text, "The text is 1801 characters and the maximum is 1800.");
  assert.equal(buildResultRender("memory_write", failed, { expanded: false }).text, "Error: The text is 1801 characters and the maximum is 1800.");
});
