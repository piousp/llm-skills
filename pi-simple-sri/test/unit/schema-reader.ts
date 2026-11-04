import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "../../src/values.ts";

// The reader the suites share: no JSON Schema validator is a dependency (ajv is not installed), so the
// constraints schemas/decision.schema.json declares are checked here, by hand, over the keywords that
// schema uses -- type, const, enum, pattern, format date-time, minLength, maxLength, minimum, minItems,
// required, properties, items and additionalProperties: false.
//
// It lives in its own module because two more suites validate records they produce (the flow of the gate
// and the acceptance), and three copies of a validator can disagree. It is not a *.test.ts, so the runner
// does not execute it as a suite; tsconfig includes test/**/*, so it is typechecked like everything else.
//
// test/unit/decision-schema.test.ts keeps the negative cases: it is the file that fixes what this reader
// catches, one injected fault per case, so a keyword the schema adds later and this reader does not know
// shows up there as a case nobody could make fail.

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "decision.schema.json",
);

// The schema as it is on disk, untyped on purpose: every read of it narrows a field to a keyword, and a
// cast to a shape of our own invention would be the one thing the reader cannot check.
export function loadDecisionSchema(): unknown {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

// Read once: the schema is a file of the package and not of the run, and every validation below reads the
// same bytes the negative cases in decision-schema.test.ts describe.
const DECISION_SCHEMA: unknown = loadDecisionSchema();

// The violations of `document` against schemas/decision.schema.json, with the JSON pointer of each one.
// An empty list is the record satisfying the schema.
export function validateAgainstSchema(document: unknown): string[] {
  const violations: string[] = [];
  collectViolations(document, DECISION_SCHEMA, "decision", violations);
  return violations;
}

function collectViolations(value: unknown, schemaNode: unknown, at: string, violations: string[]): void {
  if (!isPlainObject(schemaNode)) {
    violations.push(`${at}: the schema node is not an object`);
    return;
  }

  checkType(value, schemaNode.type, at, violations);
  checkConst(value, schemaNode, at, violations);
  checkEnum(value, schemaNode.enum, at, violations);
  checkString(value, schemaNode, at, violations);
  checkNumber(value, schemaNode, at, violations);
  checkArray(value, schemaNode, at, violations);
  checkObject(value, schemaNode, at, violations);
}

function checkType(value: unknown, declared: unknown, at: string, violations: string[]): void {
  const types = declaredTypes(declared);
  if (types.length === 0 || types.some((type) => matchesType(value, type))) {
    return;
  }
  violations.push(`${at}: expected ${types.join(" or ")}, got ${describe(value)}`);
}

// `type` is a string or a list of strings in JSON Schema. A type this reader does not know fails
// the check instead of passing silently, so a keyword added to the schema surfaces here.
function declaredTypes(declared: unknown): readonly string[] {
  if (typeof declared === "string") {
    return [declared];
  }
  if (!Array.isArray(declared)) {
    return [];
  }
  const entries: readonly unknown[] = declared;
  return entries.flatMap((entry) => (typeof entry === "string" ? [entry] : []));
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function checkConst(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  if (!Object.hasOwn(schemaNode, "const")) {
    return;
  }
  const expected = schemaNode.const;
  if (!isSameValue(value, expected)) {
    violations.push(`${at}: expected the constant ${describe(expected)}, got ${describe(value)}`);
  }
}

function checkEnum(value: unknown, options: unknown, at: string, violations: string[]): void {
  if (!Array.isArray(options)) {
    return;
  }
  const allowed: readonly unknown[] = options;
  if (allowed.some((option) => isSameValue(value, option))) {
    return;
  }
  violations.push(`${at}: expected one of ${allowed.map((option) => describe(option)).join(", ")}, got ${describe(value)}`);
}

function checkString(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  if (typeof value !== "string") {
    return;
  }

  const pattern = schemaNode.pattern;
  if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
    violations.push(`${at}: ${describe(value)} does not match /${pattern}/`);
  }

  // Only the one format the schema declares is checked; an unknown format is an annotation.
  const format = schemaNode.format;
  if (format === "date-time" && !DATE_TIME_PATTERN.test(value)) {
    violations.push(`${at}: ${describe(value)} is not a date-time`);
  }

  const minLength = schemaNode.minLength;
  if (typeof minLength === "number" && value.length < minLength) {
    violations.push(`${at}: ${describe(value)} is shorter than ${minLength}`);
  }

  const maxLength = schemaNode.maxLength;
  if (typeof maxLength === "number" && value.length > maxLength) {
    violations.push(`${at}: ${describe(value)} is longer than ${maxLength}`);
  }
}

function checkNumber(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  const minimum = schemaNode.minimum;
  if (typeof minimum !== "number" || typeof value !== "number") {
    return;
  }
  if (value < minimum) {
    violations.push(`${at}: ${value} is below the minimum ${minimum}`);
  }
}

function checkArray(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  const elements: readonly unknown[] = value;

  const minItems = schemaNode.minItems;
  if (typeof minItems === "number" && elements.length < minItems) {
    violations.push(`${at}: the array has ${elements.length} items, fewer than ${minItems}`);
  }

  const items = schemaNode.items;
  if (items === undefined) {
    return;
  }
  elements.forEach((element, index) => {
    collectViolations(element, items, `${at}[${index}]`, violations);
  });
}

function checkObject(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    return;
  }

  const required = schemaNode.required;
  const requiredNames: readonly unknown[] = Array.isArray(required) ? required : [];
  for (const name of requiredNames) {
    if (typeof name === "string" && !Object.hasOwn(value, name)) {
      violations.push(`${at}: the required property "${name}" is missing`);
    }
  }

  const declaredProperties = schemaNode.properties;
  const properties: Record<string, unknown> = isPlainObject(declaredProperties) ? declaredProperties : {};
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      collectViolations(value[key], childSchema, `${at}.${key}`, violations);
    }
  }

  if (schemaNode.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        violations.push(`${at}: the property "${key}" is not declared by the schema (additionalProperties: false)`);
      }
    }
  }
}

// The schema only uses scalar const and enum values, so comparing their JSON form is enough.
function isSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function describe(value: unknown): string {
  const json = JSON.stringify(value);
  return json ?? String(value);
}

// The schema declares createdAt as format: "date-time" and every date-time this package writes comes from
// Date#toISOString, so the accepted shape is the UTC one with milliseconds.
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
