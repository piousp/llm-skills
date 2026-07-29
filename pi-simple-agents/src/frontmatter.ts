import { parse as parseYaml } from "yaml";
import { mapClaudeTools, normalizeClaudeModel, CLAUDE_INERT_FIELDS } from "./claude-compat.ts";

const SYSTEM_PROMPT_MODES = ["append", "replace"] as const;
type SystemPromptMode = (typeof SYSTEM_PROMPT_MODES)[number];

const DEFAULT_CONTEXTS = ["forked", "fresh"] as const;
type DefaultContext = (typeof DEFAULT_CONTEXTS)[number];

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  systemPromptMode?: SystemPromptMode;
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  inheritExtensions?: boolean;
  defaultReads?: string[];
  defaultContext?: DefaultContext;
  thinking?: string;
  skills?: string[];
  [key: string]: unknown;
}

export interface FrontmatterResult {
  frontmatter: ParsedFrontmatter;
  body: string;
  inertFields: string[];
  inertTools: string[];
  modelAlias?: string;
  warnings: string[];
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const SCALAR_TYPES = new Set(["string", "number", "boolean"]);

const SCALAR_FIELDS = ["name", "description", "model", "thinking"] as const;

const ENUM_FIELDS: Array<{ key: "systemPromptMode" | "defaultContext"; allowed: readonly string[] }> = [
  { key: "systemPromptMode", allowed: SYSTEM_PROMPT_MODES },
  { key: "defaultContext", allowed: DEFAULT_CONTEXTS },
];

const BOOLEAN_FIELDS = ["inheritProjectContext", "inheritSkills", "inheritExtensions"] as const;

const LIST_FIELDS = ["tools", "disallowedTools", "defaultReads", "skills"] as const;

const CLAUDE_MAPPED_LIST_FIELDS = new Set<string>(["tools", "disallowedTools"]);

function normalizeScalar(
  value: unknown,
  fieldName: string,
  warnings: string[],
): string | undefined {
  if (!SCALAR_TYPES.has(typeof value)) {
    warnings.push(
      `Field "${fieldName}" must be a scalar value; got ${JSON.stringify(value)} - value ignored.`,
    );
    return undefined;
  }
  // Only String() non-string scalars (numbers/booleans). Already-string values are left
  // as-is so block scalars (folded/literal, e.g. "description: >") keep their meaningful
  // trailing newlines instead of being silently trimmed away.
  return typeof value === "string" ? value : String(value);
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
  warnings: string[],
): T | undefined {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  warnings.push(
    `Field "${fieldName}" must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)} - value ignored.`,
  );
  return undefined;
}

function normalizeBoolean(
  value: unknown,
  fieldName: string,
  warnings: string[],
): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  warnings.push(
    `Field "${fieldName}" must be a boolean or "true"/"false" string; got ${JSON.stringify(value)} - value ignored.`,
  );
  return undefined;
}

function normalizeTools(
  value: unknown,
  fieldName: string,
  warnings: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }
  warnings.push(
    `Field "${fieldName}" must be a string, list, or omitted; got ${JSON.stringify(value)} - value ignored.`,
  );
  return undefined;
}

function emptyResult(body: string, warnings: string[] = []): FrontmatterResult {
  return { frontmatter: {}, body, inertFields: [], inertTools: [], warnings };
}

// Matches a top-level (non-indented) `key: value` line. Indented lines (nested-mapping
// continuations, list items, block-scalar content) are deliberately excluded — recovery
// only ever rewrites lines that look like a plain top-level scalar assignment.
const PLAIN_TOP_LEVEL_KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]+(.+)$/;

// Value prefixes that indicate the author already wrote YAML syntax on purpose
// (quoted string, block scalar, flow collection, anchor/alias/tag) — never rewritten.
const YAML_SYNTAX_PREFIXES = ['"', "'", ">", "|", "[", "{", "&", "*", "!"];

// Failure-scoped lenient recovery: only ever invoked from the yaml.parse catch block below,
// i.e. strictly after the strict parse has already thrown. A block that parses cleanly on the
// first attempt never reaches this function.
function attemptLenientRecovery(block: string): { parsed: unknown; fields: string[] } | undefined {
  const recoveredFields: string[] = [];

  const rewrittenLines = block.split(/\r?\n/).map((line) => {
    const lineMatch = line.match(PLAIN_TOP_LEVEL_KEY_LINE);
    if (!lineMatch) return line;

    const [, key, rawValue] = lineMatch;
    const value = rawValue.trimEnd();
    if (YAML_SYNTAX_PREFIXES.some((prefix) => value.startsWith(prefix))) return line;
    if (!value.includes(": ")) return line;

    recoveredFields.push(key);
    return `${key}: ${JSON.stringify(value)}`;
  });

  if (recoveredFields.length === 0) return undefined;

  try {
    const parsed = parseYaml(rewrittenLines.join("\n"));
    return { parsed, fields: recoveredFields };
  } catch {
    return undefined;
  }
}

// Detection-only, warn-never-fix: after a successful FIRST-TRY parse (no recovery involved),
// flags known scalar fields whose raw source line has a space-then-'#' — a plausible sign the
// author meant literal text and didn't realize YAML would treat it as a comment marker. Never
// runs for recovered blocks; never rewrites the value.
function detectCommentTruncation(
  block: string,
  frontmatter: Record<string, unknown>,
  warnings: string[],
): void {
  const lines = block.split(/\r?\n/);

  for (const field of SCALAR_FIELDS) {
    const value = frontmatter[field];
    if (typeof value !== "string") continue;

    const linePattern = new RegExp(`^${field}:[ \\t]+(.+)$`);
    const line = lines.find((candidate) => linePattern.test(candidate));
    if (!line) continue;

    const rawValuePart = line.match(linePattern)![1];
    if (YAML_SYNTAX_PREFIXES.some((prefix) => rawValuePart.startsWith(prefix))) continue;
    if (!rawValuePart.includes(" #")) continue;

    if (rawValuePart.trim().length > value.length) {
      warnings.push(
        `possible '#' comment truncation in field "${field}" — quote the value if the '#' was meant to be literal text`,
      );
    }
  }
}

export function parseFrontmatter(content: string): FrontmatterResult {
  const match = content.match(FRONTMATTER_BLOCK);
  if (!match) {
    return emptyResult(content);
  }

  const block = match[1];
  const body = content.slice(match[0].length);

  let parsed: unknown;
  let recoveredFields: string[] | undefined;
  try {
    parsed = parseYaml(block);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recovery = attemptLenientRecovery(block);
    if (!recovery) {
      return emptyResult(content, [`Failed to parse YAML frontmatter: ${message}`]);
    }
    parsed = recovery.parsed;
    recoveredFields = recovery.fields;
  }

  if (parsed === null) {
    return emptyResult(body);
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyResult(content, ["Frontmatter block did not parse to a YAML mapping"]);
  }

  const raw = parsed as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const warnings: string[] = [];

  if (recoveredFields) {
    warnings.push(
      `field(s) ${recoveredFields.join(", ")} contained an unquoted ':' or similar and were parsed ` +
        `leniently — quote the value in the source file to silence this warning`,
    );
  }

  const inertFields = Object.keys(raw)
    .filter((key) => CLAUDE_INERT_FIELDS.has(key))
    .sort();

  const inertToolNames = new Set<string>();

  for (const field of LIST_FIELDS) {
    if (raw[field] === undefined) continue;
    const normalizedList = normalizeTools(raw[field], field, warnings);
    if (normalizedList === undefined) {
      normalized[field] = undefined;
      continue;
    }
    if (CLAUDE_MAPPED_LIST_FIELDS.has(field)) {
      const { tools: mapped, inert } = mapClaudeTools(normalizedList);
      normalized[field] = mapped;
      for (const name of inert) inertToolNames.add(name);
    } else {
      normalized[field] = normalizedList;
    }
  }

  for (const field of SCALAR_FIELDS) {
    if (raw[field] === undefined) continue;
    normalized[field] = normalizeScalar(raw[field], field, warnings);
  }

  let modelAlias: string | undefined;
  if (typeof normalized.model === "string") {
    const resolved = normalizeClaudeModel(normalized.model);
    normalized.model = resolved.model;
    modelAlias = resolved.alias;
  }

  for (const { key, allowed } of ENUM_FIELDS) {
    if (raw[key] === undefined) continue;
    normalized[key] = normalizeEnum(raw[key], allowed, key, warnings);
  }

  for (const field of BOOLEAN_FIELDS) {
    if (raw[field] === undefined) continue;
    normalized[field] = normalizeBoolean(raw[field], field, warnings);
  }

  const frontmatter: ParsedFrontmatter = { ...raw, ...normalized } as ParsedFrontmatter;

  if (!recoveredFields) {
    detectCommentTruncation(block, frontmatter, warnings);
  }

  return {
    frontmatter,
    body,
    inertFields,
    inertTools: [...inertToolNames],
    modelAlias,
    warnings,
  };
}
