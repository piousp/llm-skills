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
  "e2e: subagent tool honors a per-task `model` override in parallel mode without crashing",
  { timeout: TIMEOUT_MS + 10_000 },
  async () => {
    const prompt =
      "Usa la herramienta subagent en modo paralelo (parametro tasks) con estas dos tareas: " +
      "1) agente pablo-planner, tarea 'Consulta de prueba A: responde en una sola frase confirmando " +
      "que funcionas correctamente.', con el parametro model en 'anthropic/claude-sonnet-5' para " +
      "forzar ese modelo en lugar del que el agente use por defecto; " +
      "2) agente scout, tarea 'Consulta de prueba B: responde en una sola frase confirmando que " +
      "funcionas correctamente.', sin especificar model (usa el modelo configurado por defecto). " +
      "Reporta ambos resultados tal cual.";

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
