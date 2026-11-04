// Live smoke test: actually spawns `pi` and drives the real `subagent` tool
// end-to-end (real model call, real ~/.pi/agent config). This is the
// regression class the getModel/modelRegistry fix targets — SDK surface
// drift only shows up when the extension is loaded and run for real.
//
// NOT part of `npm test` (see README/DEVELOPER.md): slow, costs tokens,
// non-deterministic, and depends on machine-local ~/.pi/agent/agents
// config (an agent named "pablo-planner" with an agentOverrides.model
// override). Opt in explicitly:
//
//   PI_LIVE_E2E=1 npm run test:e2e
//
// Always loads the extension straight from this repo's `extensions/`
// directory (via -e, with -ne to disable other extension discovery), never
// from an installed copy, so this validates the code actually under test.
//
// stdin is explicitly "ignore"d: `pi -p` blocks reading stdin waiting for
// EOF if it's left as an open pipe (e.g. child_process.execFile's default),
// which manifests as a hang pinned exactly to whatever timeout is set —
// don't reintroduce execFile/promisify(execFile) here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSIONS_DIR = path.join(REPO_ROOT, "extensions");
const TIMEOUT_MS = 120_000;

const live = process.env.PI_LIVE_E2E ? test : test.skip;

function runPi(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stdout += d; });

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi did not exit within ${TIMEOUT_MS}ms (killed). Output so far:\n${stdout}`));
    }, TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout });
    });
  });
}

live(
  "e2e: subagent tool invokes pablo-planner via `pi -e extensions/` without crashing",
  { timeout: TIMEOUT_MS + 10_000 },
  async () => {
    const prompt =
      "Usa la herramienta subagent para invocar al agente pablo-planner con esta tarea: " +
      "'Consulta de prueba: responde en una sola frase confirmando que funcionas correctamente.' " +
      "Reporta el resultado tal cual.";

    const { code, stdout } = await runPi(["-e", EXTENSIONS_DIR, "-ne", "-p", prompt]);

    assert.equal(code, 0, `pi exited non-zero. Output:\n${stdout}`);
    assert.ok(stdout.trim().length > 0, "expected non-empty stdout from pi");
    assert.doesNotMatch(
      stdout,
      /Cannot read properties of undefined|TypeError/i,
      `pi output looked like a crash:\n${stdout}`,
    );
  },
);

live(
  "e2e: subagent tool honors a single-mode `model` override without crashing",
  { timeout: TIMEOUT_MS + 10_000 },
  async () => {
    const prompt =
      "Usa la herramienta subagent para invocar al agente pablo-planner con esta tarea: " +
      "'Consulta de prueba: responde en una sola frase confirmando que funcionas correctamente.' " +
      "Pasa el parametro model con el valor 'anthropic/claude-sonnet-5' para forzar ese modelo " +
      "en lugar del que el agente use por defecto. Reporta el resultado tal cual.";

    const { code, stdout } = await runPi(["-e", EXTENSIONS_DIR, "-ne", "-p", prompt]);

    assert.equal(code, 0, `pi exited non-zero. Output:\n${stdout}`);
    assert.ok(stdout.trim().length > 0, "expected non-empty stdout from pi");
    assert.doesNotMatch(
      stdout,
      /Cannot read properties of undefined|TypeError/i,
      `pi output looked like a crash:\n${stdout}`,
    );
  },
);

live(
  "e2e: subagent tool honors a per-call `model` override across two separate concurrent calls without crashing",
  { timeout: TIMEOUT_MS + 10_000 },
  async () => {
    const prompt =
      "Lanza dos llamadas separadas a la herramienta subagent, en el mismo turno: " +
      "1) agente pablo-planner, tarea 'Consulta de prueba A: responde en una sola frase confirmando " +
      "que funcionas correctamente.', con el parametro model en 'anthropic/claude-sonnet-5' para " +
      "forzar ese modelo en lugar del que el agente use por defecto; " +
      "2) agente scout, tarea 'Consulta de prueba B: responde en una sola frase confirmando que " +
      "funcionas correctamente.', sin especificar model (usa el modelo configurado por defecto). " +
      "Cada llamada arranca su propio job en background; espera a que lleguen los dos resultados " +
      "y reportalos tal cual.";

    const { code, stdout } = await runPi(["-e", EXTENSIONS_DIR, "-ne", "-p", prompt]);

    assert.equal(code, 0, `pi exited non-zero. Output:\n${stdout}`);
    assert.ok(stdout.trim().length > 0, "expected non-empty stdout from pi");
    assert.doesNotMatch(
      stdout,
      /Cannot read properties of undefined|TypeError/i,
      `pi output looked like a crash:\n${stdout}`,
    );
  },
);

// Preconditions for the case below (documented, not asserted blind):
// - ~/.pi/agent/mcp.json configures a server named "mde-build" with
//   `"exposure": "direct"` (pi's built-in MCP registers its "mvn" tool as
//   mcp__mde-build__mvn once the server connects).
// - An agent named "worker" is resolvable (~/.pi/agent/agents); the prompt
//   grants the MCP tool through a per-invocation `tools` override, since no
//   shipped agent lists it.
// Skips (doesn't fail) when the precondition isn't met, naming it.
const MCP_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "mcp.json");

function hasMdeBuildDirectConfigured(): boolean {
  if (!fs.existsSync(MCP_CONFIG_PATH)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
    const mdeBuild = config.mcpServers?.["mde-build"];
    return Boolean(mdeBuild && mdeBuild.exposure === "direct" && mdeBuild.enabled !== false);
  } catch {
    return false;
  }
}

// Replaces the previous two "mode gate" cases (which only asserted the
// process doesn't hang in print mode, without ever checking that MCP
// actually initialized). Now that the mode gate is gone (src/run.ts:
// bindExtensionsIfNeeded no longer checks mode; the host itself binds and
// shuts down symmetrically in every mode, print/json included — see
// DEVELOPER.md), `pi -p` is expected to both stay clean AND produce a real
// MCP tool result, not a degraded "MCP not initialized" one.
live(
  "e2e: subagent tool calls a real direct built-in MCP tool (mcp__mde-build__mvn) via `pi -p`, exits clean, and returns a real tool result (not \"MCP not initialized\")",
  { timeout: TIMEOUT_MS + 10_000 },
  async (t) => {
    if (!hasMdeBuildDirectConfigured()) {
      t.skip(`no enabled "mde-build" MCP server with "exposure": "direct" configured at ${MCP_CONFIG_PATH}`);
      return;
    }

    // The `tools` override is required: no shipped agent lists the MCP tool.
    // Earlier, spelling out an override made the model misreport a scout's
    // available tools, so the task stays minimal. Pinning --model to a
    // capable model is what actually fixes delegation reliability here —
    // the default model for `pi -p` isn't guaranteed strong enough to
    // reliably invoke `subagent` at all. Concrete arguments are given
    // because a worker won't guess a Maven projectDir (it reports BLOCKED).
    const prompt =
      "Usa la herramienta subagent para invocar al agente 'worker' con el parametro tools " +
      "[\"read\", \"mcp__mde-build__mvn\"] y esta tarea: " +
      `'Invocá el tool mcp__mde-build__mvn una vez con goal="compile" y projectDir="${os.tmpdir()}" ` +
      "(no tiene pom.xml: un error real de Maven es un resultado válido) y reportá su resultado tal cual.' " +
      "Reporta el resultado tal cual.";

    const { code, stdout } = await runPi(["-e", EXTENSIONS_DIR, "-ne", "--model", "anthropic/claude-sonnet-5", "-p", prompt]);

    assert.equal(code, 0, `pi did not exit cleanly. Output:\n${stdout}`);
    assert.doesNotMatch(
      stdout,
      /Cannot read properties of undefined|TypeError/i,
      `pi output looked like a crash:\n${stdout}`,
    );
    assert.doesNotMatch(
      stdout,
      /MCP not initialized/,
      `MCP never initialized — the tool degraded to its pre-fix behavior:\n${stdout}`,
    );
    assert.match(
      stdout,
      /"tool":\s*"mvn"|exitCode|BUILD (FAILURE|SUCCESS)/i,
      `expected a real mvn tool result (success or a real Maven error) in the output:\n${stdout}`,
    );
  },
);

// Preconditions for the case below (documented, not asserted blind):
// - ~/.pi/agent/settings.json declares the neuralwatt provider package
//   (`packages`, `npm:pi-neuralwatt-provider`), so its directory
//   (~/.pi/agent/npm/node_modules/pi-neuralwatt-provider) exists and can be
//   loaded with -e, which resolves that package's own pi.extensions.
// - `pi --list-models neuralwatt` in a fresh process (no model call) lists
//   qwen3.6-35b: the child's ref has to be a real catalogue entry, or the run
//   would fail for a reason other than the one under test.
// Skips (doesn't fail) when either precondition isn't met, naming it.
const NEURALWATT_PACKAGE = "npm:pi-neuralwatt-provider";
const NEURALWATT_PROVIDER_DIR = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-neuralwatt-provider");
const AGENT_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

function neuralwattProviderDir(): string | undefined {
  if (!fs.existsSync(AGENT_SETTINGS_PATH) || !fs.existsSync(NEURALWATT_PROVIDER_DIR)) return undefined;
  try {
    const settings = JSON.parse(fs.readFileSync(AGENT_SETTINGS_PATH, "utf8"));
    const packages: unknown = settings?.packages;
    return Array.isArray(packages) && packages.includes(NEURALWATT_PACKAGE) ? NEURALWATT_PROVIDER_DIR : undefined;
  } catch {
    return undefined;
  }
}

// The regression class of the findModel fix: a subagent whose `model` belongs
// to a provider registered by ANOTHER extension used to die on
// "was not found in the model registry" until some other job had started a
// child session in the same process. A repo fixture cannot cover it: the child
// session discovers extensions from the real ~/.pi/agent/settings.json
// (src/loader-config.ts), so a provider loaded only by `-e` never reaches the
// child's own runtime. Hence the installed provider package plus a skip.
//
// "The process's first child" is by construction: `pi -p --no-session` is a
// fresh process and the prompt asks for exactly one delegation, so no child
// ran before the subagent whose model has to resolve.
//
// `-ne` is mandatory: without it the installed copy of pi-simple-agents loads
// next to this repo's extensions/ and the `subagent` tool is registered twice.
live(
  "e2e: a subagent whose model belongs to an extension-registered provider starts as the process's first child",
  { timeout: TIMEOUT_MS + 10_000 },
  async (t) => {
    const providerDir = neuralwattProviderDir();
    if (!providerDir) {
      t.skip(`no "${NEURALWATT_PACKAGE}" package configured at ${AGENT_SETTINGS_PATH} (or ${NEURALWATT_PROVIDER_DIR} is missing)`);
      return;
    }
    const catalogue = await runPi(["--list-models", "neuralwatt"]);
    if (catalogue.code !== 0 || !catalogue.stdout.includes("qwen3.6-35b")) {
      t.skip(`\`pi --list-models neuralwatt\` does not list qwen3.6-35b (exit ${catalogue.code}). Output:\n${catalogue.stdout}`);
      return;
    }

    const prompt =
      "Haz exactamente una llamada a la herramienta subagent con estos tres parametros: " +
      "agent='scout', model='neuralwatt/qwen3.6-35b', task='Responde solo: ok'. " +
      "Reporta el resultado tal cual.";

    const { code, stdout } = await runPi([
      "-ne",
      "-e", EXTENSIONS_DIR,
      "-e", providerDir,
      "-p", "--no-session",
      "--model", "neuralwatt/deepseek-v4.1-flash",
      prompt,
    ]);

    assert.equal(code, 0, `pi exited non-zero. Output:\n${stdout}`);
    assert.doesNotMatch(
      stdout,
      /was not found in the model registry/,
      `the package runtime's false negative came back:\n${stdout}`,
    );
    assert.doesNotMatch(
      stdout,
      /Cannot read properties of undefined|TypeError/,
      `pi output looked like a crash:\n${stdout}`,
    );
    assert.match(stdout, /\bok\b/i, `expected the child's "ok" in the output:\n${stdout}`);
  },
);
