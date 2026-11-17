import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseObserveConfig,
  parseSriConfig,
  readObserveConfig,
  readObserveConfigOf,
  readSriConfig,
  readSriConfigOf,
  SriConfigError,
} from "../../src/config.ts";
import { DEFAULT_JUDGE_CALLS_PER_DAY } from "../../src/observe/types.ts";
import type { ObserveConfig } from "../../src/observe/types.ts";
import type { SriConfig } from "../../src/types.ts";

const EMPTY_CONFIG: SriConfig = { allow: [], deny: [] };

function settingsPath(fixture: string): string {
  return fileURLToPath(new URL(`../fixtures/settings/${fixture}`, import.meta.url));
}

// The directory the fixtures live in, which is what readSriConfigOf takes: it holds the files above by name and no
// settings.json of its own, so the default answer below is the one of a directory nobody configured.
function settingsDir(): string {
  return fileURLToPath(new URL("../fixtures/settings", import.meta.url));
}

// Returns whatever the call threw so the test can inspect the typed error's
// message and settingsPath; fails loudly when nothing was thrown.
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to throw");
}

const FIXTURES = [
  "observe-full.json",
  "observe-minimal.json",
  "observe-wrong-type.json",
  "observe-bad-model.json",
  "minimal.json",
  "allow-and-deny.json",
  "unknown-keys.json",
  "wrong-type.json",
  "not-object.json",
  "malformed.json",
  "jsonc.json",
];

test("settings fixtures: every file the tests read exists", () => {
  for (const fixture of FIXTURES) {
    assert.equal(fs.existsSync(settingsPath(fixture)), true, `missing fixture ${fixture}`);
  }
});

// Deliberately absent: readSriConfig must fall back to the default config here.
test("settings fixtures: no-such-file.json is absent", () => {
  assert.equal(fs.existsSync(settingsPath("no-such-file.json")), false);
});

interface RejectionCase {
  name: string;
  raw: unknown;
  messagePart: string;
}

const REJECTIONS: RejectionCase[] = [
  {
    name: "a null top level",
    raw: null,
    messagePart: "settings must be a JSON object",
  },
  {
    name: "an array top level",
    raw: [],
    messagePart: "settings must be a JSON object",
  },
  {
    name: "a string top level",
    raw: "pi-simple-sri",
    messagePart: "settings must be a JSON object",
  },
  {
    name: "a non-object \"pi-simple-sri\" value",
    raw: { "pi-simple-sri": "pdf-tools" },
    messagePart: '"pi-simple-sri" must be an object',
  },
  {
    name: "an array \"pi-simple-sri\" value",
    raw: { "pi-simple-sri": ["pdf-tools"] },
    messagePart: '"pi-simple-sri" must be an object',
  },
  {
    name: "a non-object \"skills\" value",
    raw: { "pi-simple-sri": { skills: "pdf-tools" } },
    messagePart: '"pi-simple-sri.skills" must be an object',
  },
  {
    name: "a null \"skills\" value",
    raw: { "pi-simple-sri": { skills: null } },
    messagePart: '"pi-simple-sri.skills" must be an object',
  },
  {
    name: "a string \"allow\" value",
    raw: { "pi-simple-sri": { skills: { allow: "pdf-tools" } } },
    messagePart: '"pi-simple-sri.skills.allow" must be an array of strings',
  },
  {
    name: "a number inside \"allow\"",
    raw: { "pi-simple-sri": { skills: { allow: ["pdf-tools", 42] } } },
    messagePart: '"pi-simple-sri.skills.allow" must be an array of strings',
  },
  {
    name: "a null inside \"deny\"",
    raw: { "pi-simple-sri": { skills: { deny: ["system-config", null] } } },
    messagePart: '"pi-simple-sri.skills.deny" must be an array of strings',
  },
  {
    name: "an object \"deny\" value",
    raw: { "pi-simple-sri": { skills: { deny: { pdf: true } } } },
    messagePart: '"pi-simple-sri.skills.deny" must be an array of strings',
  },
];

for (const testCase of REJECTIONS) {
  test(`parseSriConfig: rejects ${testCase.name}`, () => {
    const error = captureError(() => parseSriConfig(testCase.raw));

    assert.ok(error instanceof SriConfigError);
    assert.ok(
      error.message.includes(testCase.messagePart),
      `expected message to include ${JSON.stringify(testCase.messagePart)}, got ${JSON.stringify(error.message)}`,
    );
    // parseSriConfig has no file to blame, so the error carries no path at all.
    assert.equal(error.settingsPath, undefined);
  });
}

interface AcceptanceCase {
  name: string;
  raw: unknown;
  expected: SriConfig;
}

const ACCEPTANCES: AcceptanceCase[] = [
  {
    name: "an empty object",
    raw: {},
    expected: EMPTY_CONFIG,
  },
  {
    name: "an object without the pi-simple-sri key",
    raw: { theme: "dark" },
    expected: EMPTY_CONFIG,
  },
  {
    name: "the pi-simple-sri key with no skills",
    raw: { "pi-simple-sri": {} },
    expected: EMPTY_CONFIG,
  },
  {
    name: "the pi-simple-sri key with empty skills",
    raw: { "pi-simple-sri": { skills: {} } },
    expected: EMPTY_CONFIG,
  },
  {
    name: "allow only",
    raw: { "pi-simple-sri": { skills: { allow: ["pdf-tools"] } } },
    expected: { allow: ["pdf-tools"], deny: [] },
  },
  {
    name: "deny only",
    raw: { "pi-simple-sri": { skills: { deny: ["system-config"] } } },
    expected: { allow: [], deny: ["system-config"] },
  },
  {
    name: "both lists",
    raw: { "pi-simple-sri": { skills: { allow: ["pdf-tools", "code-review"], deny: ["system-config"] } } },
    expected: { allow: ["pdf-tools", "code-review"], deny: ["system-config"] },
  },
  {
    name: "empty lists",
    raw: { "pi-simple-sri": { skills: { allow: [], deny: [] } } },
    expected: EMPTY_CONFIG,
  },
  {
    name: "unknown keys at every level",
    raw: {
      theme: "dark",
      "pi-simple-sri": {
        verbose: true,
        skills: { allow: ["pdf-tools"], unknownScope: "session" },
      },
    },
    expected: { allow: ["pdf-tools"], deny: [] },
  },
];

for (const testCase of ACCEPTANCES) {
  test(`parseSriConfig: accepts ${testCase.name}`, () => {
    assert.deepEqual(parseSriConfig(testCase.raw), testCase.expected);
  });
}

test("parseSriConfig: the returned lists do not alias the parsed object", () => {
  const allow = ["pdf-tools"];
  const raw = { "pi-simple-sri": { skills: { allow } } };

  const config = parseSriConfig(raw);

  allow.push("code-review");
  assert.deepEqual(config.allow, ["pdf-tools"]);
});

test("readSriConfig: a missing settings file yields the default config", () => {
  assert.deepEqual(readSriConfig(settingsPath("no-such-file.json")), EMPTY_CONFIG);
});

test("readSriConfig: a settings file without the pi-simple-sri key yields the default config", () => {
  assert.deepEqual(readSriConfig(settingsPath("minimal.json")), EMPTY_CONFIG);
});

test("readSriConfig: reads allow and deny from the pi-simple-sri key", () => {
  assert.deepEqual(readSriConfig(settingsPath("allow-and-deny.json")), {
    allow: ["pdf-tools", "code-review"],
    deny: ["system-config"],
  });
});

test("readSriConfig: ignores unknown keys around and inside the pi-simple-sri key", () => {
  assert.deepEqual(readSriConfig(settingsPath("unknown-keys.json")), {
    allow: ["pdf-tools"],
    deny: ["system-config"],
  });
});

test("readSriConfig: malformed JSON fails with the settings path on the error and in the message", () => {
  const path = settingsPath("malformed.json");

  const error = captureError(() => readSriConfig(path));

  assert.ok(error instanceof SriConfigError);
  assert.equal(error.settingsPath, path);
  assert.ok(error.message.includes(path), `expected message to include the path, got ${JSON.stringify(error.message)}`);
  assert.ok(error.message.includes("invalid JSON"), `expected a JSON parse failure, got ${JSON.stringify(error.message)}`);
});

test("readSriConfig: JSON with comments is rejected, since the file is parsed as strict JSON", () => {
  const path = settingsPath("jsonc.json");

  const error = captureError(() => readSriConfig(path));

  assert.ok(error instanceof SriConfigError);
  assert.equal(error.settingsPath, path);
  assert.ok(error.message.includes(path));
  assert.ok(error.message.includes("invalid JSON"));
});

test("readSriConfig: a well-formed file with a wrong-typed allow fails with the settings path", () => {
  const path = settingsPath("wrong-type.json");

  const error = captureError(() => readSriConfig(path));

  assert.ok(error instanceof SriConfigError);
  assert.equal(error.settingsPath, path);
  assert.ok(error.message.includes(path));
  assert.ok(error.message.includes('"pi-simple-sri.skills.allow" must be an array of strings'));
});

test("readSriConfig: a non-object pi-simple-sri value fails with the settings path", () => {
  const path = settingsPath("not-object.json");

  const error = captureError(() => readSriConfig(path));

  assert.ok(error instanceof SriConfigError);
  assert.equal(error.settingsPath, path);
  assert.ok(error.message.includes('"pi-simple-sri" must be an object'));
  assert.ok(error.message.includes(path));
});

// B4: the settings of one agent directory, and the one place outside src/names.ts that spells the name of the file. The
// reader is a parameter, so the join and the seam are proved without a file on disk: what the function answers is what the
// reader answered, and the only path it built is the one under the directory it was given.
test("readSriConfigOf: joins settings.json under the agent directory and reads it with the reader it is given", () => {
  const reads: string[] = [];
  const injected: SriConfig = { allow: ["pdf-tools"], deny: ["system-config"] };

  const config = readSriConfigOf("/agent", (settingsRead) => {
    reads.push(settingsRead);
    return injected;
  });

  assert.deepEqual(reads, [path.join("/agent", "settings.json")]);
  // The value is the reader's, not one this function built: it parses nothing and defaults nothing.
  assert.equal(config, injected);
});

// The default reader is the one of this module, and its answer for a directory that holds no settings.json is the default
// config -- every skill but the reserved name -- so the join is also proved against the real one.
test("readSriConfigOf: an agent directory with no settings file answers the default config", () => {
  assert.equal(fs.existsSync(path.join(settingsDir(), "settings.json")), false);
  assert.deepEqual(readSriConfigOf(settingsDir()), EMPTY_CONFIG);
});

// WP2: the observer's settings live under `pi-simple-sri.observe`. They are read apart from SriConfig, fail closed with the
// same error, and a broken `observe` never breaks the skills lists (nor the other way round).
const DEFAULT_OBSERVE: ObserveConfig = {
  enabled: false,
  judgeModel: null,
  judgeCallsPerDay: DEFAULT_JUDGE_CALLS_PER_DAY,
  replayAllow: [],
};

const OBSERVE_REJECTIONS: RejectionCase[] = [
  { name: "a non-object observe", raw: { "pi-simple-sri": { observe: true } }, messagePart: '"pi-simple-sri.observe" must be an object' },
  { name: "a null observe", raw: { "pi-simple-sri": { observe: null } }, messagePart: '"pi-simple-sri.observe" must be an object' },
  { name: "a string enabled", raw: { "pi-simple-sri": { observe: { enabled: "yes" } } }, messagePart: '"pi-simple-sri.observe.enabled" must be a boolean' },
  { name: "a numeric enabled", raw: { "pi-simple-sri": { observe: { enabled: 1 } } }, messagePart: '"pi-simple-sri.observe.enabled" must be a boolean' },
  { name: "a judgeModel without a provider", raw: { "pi-simple-sri": { observe: { judgeModel: "claude" } } }, messagePart: '"pi-simple-sri.observe.judgeModel" must be "provider/id"' },
  { name: "a judgeModel with an empty id", raw: { "pi-simple-sri": { observe: { judgeModel: "anthropic/" } } }, messagePart: '"pi-simple-sri.observe.judgeModel" must be "provider/id"' },
  { name: "a judgeModel with an empty provider", raw: { "pi-simple-sri": { observe: { judgeModel: "/claude" } } }, messagePart: '"pi-simple-sri.observe.judgeModel" must be "provider/id"' },
  { name: "a non-string judgeModel", raw: { "pi-simple-sri": { observe: { judgeModel: 3 } } }, messagePart: '"pi-simple-sri.observe.judgeModel" must be "provider/id"' },
  { name: "a non-object limits", raw: { "pi-simple-sri": { observe: { limits: 5 } } }, messagePart: '"pi-simple-sri.observe.limits" must be an object' },
  { name: "a fractional judgeCallsPerDay", raw: { "pi-simple-sri": { observe: { limits: { judgeCallsPerDay: 2.5 } } } }, messagePart: '"pi-simple-sri.observe.limits.judgeCallsPerDay" must be a non-negative integer' },
  { name: "a negative judgeCallsPerDay", raw: { "pi-simple-sri": { observe: { limits: { judgeCallsPerDay: -1 } } } }, messagePart: '"pi-simple-sri.observe.limits.judgeCallsPerDay" must be a non-negative integer' },
  { name: "a string judgeCallsPerDay", raw: { "pi-simple-sri": { observe: { limits: { judgeCallsPerDay: "20" } } } }, messagePart: '"pi-simple-sri.observe.limits.judgeCallsPerDay" must be a non-negative integer' },
  { name: "a non-object replay", raw: { "pi-simple-sri": { observe: { replay: [] } } }, messagePart: '"pi-simple-sri.observe.replay" must be an object' },
  { name: "a string replay allow", raw: { "pi-simple-sri": { observe: { replay: { allow: "pdf-tools" } } } }, messagePart: '"pi-simple-sri.observe.replay.allow" must be an array of strings' },
  { name: "a number inside replay allow", raw: { "pi-simple-sri": { observe: { replay: { allow: ["pdf-tools", 4] } } } }, messagePart: '"pi-simple-sri.observe.replay.allow" must be an array of strings' },
  { name: "a non-object top level", raw: [], messagePart: "settings must be a JSON object" },
  { name: "a non-object pi-simple-sri", raw: { "pi-simple-sri": "x" }, messagePart: '"pi-simple-sri" must be an object' },
];

for (const testCase of OBSERVE_REJECTIONS) {
  test(`parseObserveConfig: rejects ${testCase.name}`, () => {
    const error = captureError(() => parseObserveConfig(testCase.raw));

    assert.ok(error instanceof SriConfigError);
    assert.ok(
      error.message.includes(testCase.messagePart),
      `expected message to include ${JSON.stringify(testCase.messagePart)}, got ${JSON.stringify(error.message)}`,
    );
    assert.equal(error.settingsPath, undefined);
  });
}

const OBSERVE_ACCEPTANCES: { name: string; raw: unknown; expected: ObserveConfig }[] = [
  { name: "an empty object", raw: {}, expected: DEFAULT_OBSERVE },
  { name: "the pi-simple-sri key with no observe", raw: { "pi-simple-sri": { skills: { allow: ["x"] } } }, expected: DEFAULT_OBSERVE },
  { name: "an empty observe", raw: { "pi-simple-sri": { observe: {} } }, expected: DEFAULT_OBSERVE },
  { name: "enabled only", raw: { "pi-simple-sri": { observe: { enabled: true } } }, expected: { ...DEFAULT_OBSERVE, enabled: true } },
  {
    name: "a judgeModel with a slash in the id",
    raw: { "pi-simple-sri": { observe: { judgeModel: "openrouter/anthropic/claude" } } },
    expected: { ...DEFAULT_OBSERVE, judgeModel: { provider: "openrouter", id: "anthropic/claude" } },
  },
  {
    name: "a zero judgeCallsPerDay",
    raw: { "pi-simple-sri": { observe: { limits: { judgeCallsPerDay: 0 } } } },
    expected: { ...DEFAULT_OBSERVE, judgeCallsPerDay: 0 },
  },
  {
    name: "every key",
    raw: {
      "pi-simple-sri": {
        observe: {
          enabled: true,
          judgeModel: "anthropic/claude-haiku-4-5",
          limits: { judgeCallsPerDay: 5, unknown: 1 },
          replay: { allow: ["pdf-tools"], unknown: 1 },
          unknown: 1,
        },
      },
    },
    expected: {
      enabled: true,
      judgeModel: { provider: "anthropic", id: "claude-haiku-4-5" },
      judgeCallsPerDay: 5,
      replayAllow: ["pdf-tools"],
    },
  },
];

for (const testCase of OBSERVE_ACCEPTANCES) {
  test(`parseObserveConfig: accepts ${testCase.name}`, () => {
    assert.deepEqual(parseObserveConfig(testCase.raw), testCase.expected);
  });
}

test("parseObserveConfig: the default is off, so nothing observes until the user opts in", () => {
  assert.equal(parseObserveConfig({}).enabled, false);
});

test("parseObserveConfig: the returned replay list does not alias the parsed object", () => {
  const allow = ["pdf-tools"];
  const config = parseObserveConfig({ "pi-simple-sri": { observe: { replay: { allow } } } });

  allow.push("code-review");
  assert.deepEqual(config.replayAllow, ["pdf-tools"]);
});

test("parseSriConfig: a malformed observe section does not break the skills lists", () => {
  assert.deepEqual(parseSriConfig({ "pi-simple-sri": { skills: { allow: ["pdf-tools"] }, observe: "garbage" } }), {
    allow: ["pdf-tools"],
    deny: [],
  });
});

test("parseObserveConfig: a malformed skills section does not break the observe settings", () => {
  assert.deepEqual(parseObserveConfig({ "pi-simple-sri": { skills: "garbage", observe: { enabled: true } } }), {
    ...DEFAULT_OBSERVE,
    enabled: true,
  });
});

test("readObserveConfig: a missing settings file yields the default, off", () => {
  assert.deepEqual(readObserveConfig(settingsPath("no-such-file.json")), DEFAULT_OBSERVE);
});

test("readObserveConfig: a settings file without the observe key yields the default", () => {
  assert.deepEqual(readObserveConfig(settingsPath("allow-and-deny.json")), DEFAULT_OBSERVE);
});

test("readObserveConfig: reads every key of the observe section", () => {
  assert.deepEqual(readObserveConfig(settingsPath("observe-full.json")), {
    enabled: true,
    judgeModel: { provider: "anthropic", id: "claude-haiku-4-5" },
    judgeCallsPerDay: 5,
    replayAllow: ["pdf-tools", "code-review"],
  });
  assert.deepEqual(readObserveConfig(settingsPath("observe-minimal.json")), { ...DEFAULT_OBSERVE, enabled: true });
});

test("readObserveConfig: a wrong-typed key fails with the settings path on the error and in the message", () => {
  const file = settingsPath("observe-wrong-type.json");

  const error = captureError(() => readObserveConfig(file));

  assert.ok(error instanceof SriConfigError);
  assert.equal(error.settingsPath, file);
  assert.ok(error.message.includes(file));
  assert.ok(error.message.includes('"pi-simple-sri.observe.enabled" must be a boolean'));
});

test("readObserveConfig: a judgeModel that is not provider/id fails with the settings path", () => {
  const file = settingsPath("observe-bad-model.json");

  const error = captureError(() => readObserveConfig(file));

  assert.ok(error instanceof SriConfigError);
  assert.equal(error.settingsPath, file);
  assert.ok(error.message.includes('"pi-simple-sri.observe.judgeModel" must be "provider/id"'));
});

test("readObserveConfig: malformed JSON fails closed like the skills reader", () => {
  const file = settingsPath("malformed.json");

  const error = captureError(() => readObserveConfig(file));

  assert.ok(error instanceof SriConfigError);
  assert.equal(error.settingsPath, file);
  assert.ok(error.message.includes("invalid JSON"));
});

test("readObserveConfigOf: joins settings.json under the agent directory and reads it with the reader it is given", () => {
  const reads: string[] = [];
  const injected: ObserveConfig = { ...DEFAULT_OBSERVE, enabled: true };

  const config = readObserveConfigOf("/agent", (settingsRead) => {
    reads.push(settingsRead);
    return injected;
  });

  assert.deepEqual(reads, [path.join("/agent", "settings.json")]);
  assert.equal(config, injected);
});

test("readObserveConfigOf: an agent directory with no settings file answers the default", () => {
  assert.deepEqual(readObserveConfigOf(settingsDir()), DEFAULT_OBSERVE);
});
