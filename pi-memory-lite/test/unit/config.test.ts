import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  DEFAULT_CATEGORIES,
  DIR_ENV_VAR,
  MEMORIES_DIR,
  MIN_NODE,
  MIN_NODE_23,
  SETTINGS_KEY,
  checkNodeVersion,
  resolveConfig,
} from "../../src/config.ts";
import { toSlug } from "../../src/query.ts";

// I1: the settings surface, resolved without touching the disk. `resolveConfig` is a function of its three arguments,
// so this suite is a list of blocks and environments and their expected configuration: a fixture on `settings.json`
// would prove something the module does not do, because it never reads one. There is one test per rule, so a
// rule that is dropped fails here under the name of the rule it dropped.

const AGENT_DIR = "/home/test/.pi/agent";
const ENV_DIR = "/srv/memory";
const SETTINGS_DIR = "/opt/memory";

/** The input with the settings block replaced, the agent directory and an empty environment otherwise fixed. */
function resolve(block: unknown = {}, env: Readonly<Record<string, string | undefined>> = {}): ReturnType<typeof resolveConfig> {
  return resolveConfig({ raw: { [SETTINGS_KEY]: block }, env, agentDir: AGENT_DIR });
}

// --- defaults -------------------------------------------------------------------------------------------------------

// No settings at all is the normal state of a fresh install: the defaults, and no warning to log on every session of a
// user who never configured the package. Only a block that is present and wrong is worth a warning.
test("resolveConfig: un settings sin bloque produce los valores por defecto sin aviso", () => {
  const { config, warnings } = resolveConfig({ raw: {}, env: {}, agentDir: AGENT_DIR });

  assert.equal(warnings.length, 0);
  assert.deepEqual(config.categories, [...DEFAULT_CATEGORIES]);
  assert.equal(config.allowUnknownCategory, false);
  assert.equal(config.exposure, "direct");
  assert.equal(config.dir, join(AGENT_DIR, MEMORIES_DIR));
  assert.equal(config.source, "default");
});

// An empty block is a block: nothing to warn about, and every option takes its documented default.
test("resolveConfig: un bloque vacío produce los valores por defecto sin avisos", () => {
  const { config, warnings } = resolve();

  assert.deepEqual(warnings, []);
  assert.deepEqual(config.categories, [...DEFAULT_CATEGORIES]);
  assert.equal(config.allowUnknownCategory, false);
  assert.equal(config.exposure, "direct");
  assert.equal(config.source, "default");
});

// A block of the wrong type is one warning that names the shape found, and the defaults, and it does not throw.
test("resolveConfig: un bloque que no es objeto produce un aviso y los valores por defecto", () => {
  const { config, warnings } = resolve("x");

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pi-memory-lite/);
  assert.match(warnings[0], /string/);
  assert.deepEqual(config.categories, [...DEFAULT_CATEGORIES]);
  assert.equal(config.exposure, "direct");
  assert.equal(config.source, "default");
});

// The whole point of the function: settings are user input, so no shape of it may reach the caller as an exception.
test("resolveConfig: no lanza con ninguna forma inválida de entrada", () => {
  for (const raw of [null, undefined, 42, "text", []]) {
    const result = resolveConfig({ raw, env: {}, agentDir: AGENT_DIR });

    assert.equal(result.warnings.length, 1, `una sola advertencia para ${JSON.stringify(raw)}`);
    assert.equal(result.config.exposure, "direct");
    assert.equal(result.config.source, "default");
  }
});

// --- exposure -------------------------------------------------------------------------------------------------------

// The two non-default modes are taken as written; they are what removes the tools from the prompt.
test("resolveConfig: una exposure válida se respeta", () => {
  for (const exposure of ["codemode", "deferred"] as const) {
    const { config, warnings } = resolve({ exposure });

    assert.equal(config.exposure, exposure);
    assert.deepEqual(warnings, []);
  }
});

// A typo in the mode would hide the tools silently, so an unknown value degrades to `direct` with one warning.
test("resolveConfig: una exposure inválida degrada a direct con un aviso", () => {
  for (const exposure of ["Direct", "hidden", 42]) {
    const { config, warnings } = resolve({ exposure });

    assert.equal(config.exposure, "direct");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /exposure/);
  }
});

// --- categories -----------------------------------------------------------------------------------------------------

// The list replaces the default one, and every element is the slug the rest of the package compares against: accents
// leave, case leaves, and a duplicate of an earlier slug does not appear twice.
test("resolveConfig: las categories se normalizan y se deduplican", () => {
  const { config, warnings } = resolve({ categories: ["Religion", "religión", "env"] });

  assert.deepEqual(config.categories, ["religion", "env"]);
  assert.deepEqual(warnings, []);
});

// An element that normalizes to nothing is dropped alone: the rest of the list survives and one warning names it.
test("resolveConfig: un elemento que normaliza a vacío se descarta con su aviso", () => {
  const { config, warnings } = resolve({ categories: ["!!!", "env"] });

  assert.deepEqual(config.categories, ["env"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /!!!/);
  assert.match(warnings[0], /dropped/);
});

// A value that is not an array falls back to the default vocabulary, because a string is not a list of one category.
test("resolveConfig: categories que no es arreglo cae en las categorías por defecto con un aviso", () => {
  const { config, warnings } = resolve({ categories: "general" });

  assert.deepEqual(config.categories, [...DEFAULT_CATEGORIES]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /categories/);
});

// The default vocabulary spelled out: the tests above compare against the constant, so a list that lost a slug or repeated
// one would stay green there. This one pins the ten the README documents, in the order it promises, and checks that each
// one is already the slug the comparison uses, because a default that normalization would rewrite is a default nobody got.
test("resolveConfig: las categorías por defecto son diez slugs en orden y sin repeticiones", () => {
  const { config, warnings } = resolve({});

  assert.deepEqual(config.categories, [
    "general",
    "decision",
    "preference",
    "env",
    "project",
    "gotcha",
    "convention",
    "workflow",
    "reference",
    "person",
  ]);
  assert.deepEqual(warnings, []);

  for (const slug of config.categories) {
    assert.equal(toSlug(slug), slug, `la categoría por defecto "${slug}" tiene que ser ya un slug`);
  }
  assert.equal(new Set(config.categories).size, config.categories.length, "ninguna categoría puede repetirse");
});

// --- allowUnknownCategory -------------------------------------------------------------------------------------------

// Absent is `false`, and so is a boolean `false`: only the boolean `true` opens the vocabulary.
test("resolveConfig: allowUnknownCategory ausente es false sin aviso", () => {
  const { config, warnings } = resolve({});

  assert.equal(config.allowUnknownCategory, false);
  assert.deepEqual(warnings, []);
});

test("resolveConfig: allowUnknownCategory en true se respeta", () => {
  const { config, warnings } = resolve({ allowUnknownCategory: true });

  assert.equal(config.allowUnknownCategory, true);
  assert.deepEqual(warnings, []);
});

// The string "true" is a typo, not a truthy value: it warns and stays closed, the safe direction.
test("resolveConfig: allowUnknownCategory en string avisa y queda en false", () => {
  const { config, warnings } = resolve({ allowUnknownCategory: "true" });

  assert.equal(config.allowUnknownCategory, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /allowUnknownCategory/);
});

// --- directory ------------------------------------------------------------------------------------------------------

// The environment wins over the block, which wins over the default; all three levels report where they came from.
test("resolveConfig: el entorno gana sobre settings y sobre el default", () => {
  const { config, warnings } = resolve({ dir: SETTINGS_DIR }, { [DIR_ENV_VAR]: ENV_DIR });

  assert.equal(config.dir, ENV_DIR);
  assert.equal(config.source, "env");
  assert.deepEqual(warnings, []);
});

test("resolveConfig: settings gana sobre el default", () => {
  const { config, warnings } = resolve({ dir: SETTINGS_DIR });

  assert.equal(config.dir, SETTINGS_DIR);
  assert.equal(config.source, "settings");
  assert.deepEqual(warnings, []);
});

// A relative path in the environment is rejected with a warning and the block below it still answers, so one bad level
// does not cost the configuration the others provide.
test("resolveConfig: un directorio relativo en el entorno avisa y cae en settings", () => {
  const { config, warnings } = resolve({ dir: SETTINGS_DIR }, { [DIR_ENV_VAR]: "memory-lite" });

  assert.equal(config.dir, SETTINGS_DIR);
  assert.equal(config.source, "settings");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(DIR_ENV_VAR));
});

// The database always sits at the same name under whatever directory was resolved.
test("resolveConfig: dbPath es el archivo de la base dentro del directorio", () => {
  const { config } = resolveConfig({ raw: {}, env: { [DIR_ENV_VAR]: ENV_DIR }, agentDir: AGENT_DIR });

  assert.equal(config.dbPath, join(ENV_DIR, "memory.db"));
});

// The default directory is spelled out instead of compared against the constant: the tests above read `MEMORIES_DIR`, so
// a renamed constant would move the default silently and stay green. This one pins the path the README promises.
test("resolveConfig: el directorio por defecto es lite-memories bajo agentDir", () => {
  const { config, warnings } = resolveConfig({ raw: {}, env: {}, agentDir: AGENT_DIR });

  assert.equal(config.dir, join(AGENT_DIR, "lite-memories"), "el directorio por defecto tiene que ser lite-memories");
  assert.equal(config.dbPath, join(AGENT_DIR, "lite-memories", "memory.db"));
  assert.equal(config.source, "default");
  assert.deepEqual(warnings, []);
});

// --- checkNodeVersion -----------------------------------------------------------------------------------------------

// The two shapes that pass: with the leading `v` and without it, and both at or above the minimum.
test("checkNodeVersion: 22.14.0 y v24.19.0 pasan el chequeo", () => {
  assert.deepEqual(checkNodeVersion("22.14.0"), { ok: true });
  assert.deepEqual(checkNodeVersion("v24.19.0"), { ok: true });
});

// The sentence is the contract: it names the requirement and the version found, and it says the tools are still there.
test("checkNodeVersion: 22.13.0 falla con el mensaje exacto", () => {
  const result = checkNodeVersion("22.13.0");

  if (result.ok) assert.fail("22.13.0 no debería pasar el chequeo");
  assert.equal(
    result.message,
    "pi-memory-lite requires Node >= 22.14 for node:sqlite (found 22.13.0); the memory tools are registered but will return this error.",
  );
});

// The minor is compared as a number and not as a string, which is the difference between 22.6 and 22.14.
test("checkNodeVersion: 22.6.0 falla y nombra ambas versiones", () => {
  const result = checkNodeVersion("22.6.0");

  if (result.ok) assert.fail("22.6.0 no debería pasar el chequeo");
  assert.match(result.message, /22\.14/);
  assert.match(result.message, /22\.6\.0/);
});

// An unreadable version is a failure too: there is no reading of "nonsense" that makes `node:sqlite` available.
test("checkNodeVersion: una versión ilegible falla sin lanzar", () => {
  for (const version of ["nonsense", ""]) {
    const result = checkNodeVersion(version);

    if (result.ok) assert.fail(`"${version}" no debería pasar el chequeo`);
    assert.match(result.message, new RegExp(MIN_NODE.join("\\.")));
  }
});

// la línea 23 tiene su propio suelo. 23.0 a 23.4 están por encima de 22.14 y aun así no tienen `node:sqlite`: el
// módulo sigue detrás de `--experimental-sqlite`, que una sesión de pi no pasa. Sin esta rama el modelo lee el error
// crudo del import en vez de la oración que nombra el requisito.
test("checkNodeVersion: 23.0.0 y 23.4.9 fallan y 23.5.0 pasa", () => {
  for (const version of ["23.0.0", "23.4.9"]) {
    const result = checkNodeVersion(version);

    if (result.ok) assert.fail(`${version} no debería pasar el chequeo: node:sqlite está detrás de un flag ahí`);
    // La sentencia nombra las dos versiones: el suelo que falta y la que se encontró.
    assert.match(result.message, new RegExp(MIN_NODE_23.join("\\.")));
    assert.match(result.message, new RegExp(version.replaceAll(".", "\\.")));
    assert.match(result.message, /node:sqlite/);
  }

  assert.deepEqual(checkNodeVersion("23.5.0"), { ok: true });
  assert.deepEqual(checkNodeVersion("v23.5.1"), { ok: true });
});
