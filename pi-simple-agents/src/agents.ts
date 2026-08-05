import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, type FrontmatterResult } from "./frontmatter.ts";
import { claimUnwarned, reportInertUsage } from "./claude-compat.ts";
import { WARN_PREFIX, toErrorMessage } from "./warn.ts";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  defaultReads: string[];
  source: "user";
  filePath: string;
  systemPrompt: string;
  thinking?: string;
  inheritSkills?: boolean;
  inheritExtensions?: boolean;
  defaultContext?: "forked" | "fresh";
  skills?: string[];
  /** Max wall-clock time for one run's prompt execution, in ms. Settings-only (agentOverrides). */
  timeoutMs?: number;
}

export interface AgentOverrides {
  [agentName: string]: Partial<AgentConfig>;
}

export interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

const CACHE_TTL_MS = 5_000;

/**
 * Shared TTL-cache mechanic: returns a cached in-flight/fresh promise on hit
 * (same promise object, for in-flight dedupe), otherwise computes and stores
 * a new one synchronously (before any await) with a creation-time timestamp.
 * With no cache provided, just computes directly.
 */
function cachedPromise<T>(
  cache: Map<string, CacheEntry<Promise<T>>> | undefined,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  if (!cache) {
    return compute();
  }

  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const promise = compute();
  cache.set(key, { timestamp: Date.now(), data: promise });
  return promise;
}

function aggregateInertUsage(
  perFileResults: Array<Pick<FrontmatterResult, "inertFields" | "inertTools" | "modelAlias">>,
): { fields: Set<string>; tools: Set<string>; models: Set<string> } {
  const fields = new Set<string>();
  const tools = new Set<string>();
  const models = new Set<string>();

  for (const result of perFileResults) {
    for (const name of result.inertFields) fields.add(name);
    for (const name of result.inertTools) tools.add(name);
    if (result.modelAlias) models.add(result.modelAlias);
  }

  return { fields, tools, models };
}

const MANIFEST_FILENAME = "AGENT.md";

interface AgentSource {
  filePath: string;
  fallbackName?: string;
}

async function resolveAgentSource(
  agentsDir: string,
  entry: fs.Dirent,
): Promise<AgentSource | undefined> {
  if (entry.name.endsWith(".md")) {
    return { filePath: path.join(agentsDir, entry.name) };
  }
  const manifestPath = path.join(agentsDir, entry.name, MANIFEST_FILENAME);
  try {
    const stat = await fsPromises.stat(manifestPath);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return { filePath: manifestPath, fallbackName: entry.name };
}

interface DiscoveredFileResult {
  warnings: string[];
  agent?: AgentConfig;
  frontmatterResult?: FrontmatterResult;
}

/**
 * First-wins dedup by resolved agent name: keeps the first agent seen for
 * each name (in input order) and warns for every later duplicate. The warning
 * is throttled per resolved name via `claimUnwarned`, same TTL and registry
 * mechanic as `reportInertUsage`'s inert-usage warnings.
 */
export function dedupeByResolvedName(
  agents: AgentConfig[],
  warnRegistry: Map<string, number>,
): AgentConfig[] {
  const seenNames = new Map<string, string>(); // resolved name -> first filePath
  const deduped: AgentConfig[] = [];

  for (const agent of agents) {
    const firstPath = seenNames.get(agent.name);
    if (firstPath !== undefined) {
      const claimed = claimUnwarned([`duplicate-agent:${agent.name}`], warnRegistry);
      if (claimed.length > 0) {
        console.warn(
          `${WARN_PREFIX}skipping duplicate agent "${agent.name}" `
            + `at ${agent.filePath} — already defined at ${firstPath}`,
        );
      }
      continue;
    }
    seenNames.set(agent.name, agent.filePath);
    deduped.push(agent);
  }

  return deduped;
}

async function discoverAgentFile(
  filePath: string,
  fallbackName?: string,
): Promise<DiscoveredFileResult> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.stat(filePath);
  } catch {
    return { warnings: [`pi-simple-agents: skipping unreadable file ${filePath}`] };
  }
  if (!stat.isFile()) {
    return { warnings: [] };
  }

  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf8");
  } catch {
    return { warnings: [`pi-simple-agents: skipping unreadable file ${filePath}`] };
  }

  const result = parseFrontmatter(content);
  const { frontmatter, body, warnings } = result;
  const fileWarnings = warnings.map((warning) => `pi-simple-agents: ${filePath}: ${warning}`);

  const resolvedName = frontmatter.name ?? fallbackName;
  if (!resolvedName || !frontmatter.description) {
    fileWarnings.push(
      `pi-simple-agents: skipping ${filePath} — missing required "name" or "description"`,
    );
    return { warnings: fileWarnings, frontmatterResult: result };
  }

  const agent: AgentConfig = {
    name: resolvedName,
    description: frontmatter.description,
    tools: frontmatter.tools,
    disallowedTools: frontmatter.disallowedTools,
    model: frontmatter.model,
    systemPromptMode: frontmatter.systemPromptMode ?? "append",
    inheritProjectContext: frontmatter.inheritProjectContext ?? true,
    defaultReads: frontmatter.defaultReads ?? [],
    source: "user",
    filePath,
    systemPrompt: body.trim(),
    thinking: frontmatter.thinking,
    inheritSkills: frontmatter.inheritSkills,
    inheritExtensions: frontmatter.inheritExtensions,
    defaultContext: frontmatter.defaultContext,
    skills: frontmatter.skills,
  };

  return { warnings: fileWarnings, agent, frontmatterResult: result };
}

export function discoverAgents(
  agentsDir: string,
  cache: Map<string, CacheEntry<Promise<AgentConfig[]>>> | undefined,
  warnRegistry: Map<string, number>,
): Promise<AgentConfig[]> {
  return cachedPromise(cache, agentsDir, async (): Promise<AgentConfig[]> => {
    try {
      let entries: fs.Dirent[];
      try {
        entries = await fsPromises.readdir(agentsDir, { withFileTypes: true });
      } catch {
        return [];
      }

      // Sort by filename before any async fan-out so collision resolution
      // (first-wins dedup) is deterministic across filesystems/OSes instead
      // of depending on readdir's unspecified raw entry order.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      const sources = (
        await Promise.all(entries.map((entry) => resolveAgentSource(agentsDir, entry)))
      ).filter((s): s is AgentSource => s !== undefined);

      // Promise.all preserves input order in its result array regardless of
      // settlement order, so the sorted entry order above is preserved here
      // for free.
      const fileResults = await Promise.all(
        sources.map((s) => discoverAgentFile(s.filePath, s.fallbackName)),
      );

      const candidateAgents: AgentConfig[] = [];
      const perFileResults: FrontmatterResult[] = [];

      for (const fileResult of fileResults) {
        for (const warning of fileResult.warnings) console.warn(warning);
        if (fileResult.frontmatterResult) perFileResults.push(fileResult.frontmatterResult);
        if (fileResult.agent) candidateAgents.push(fileResult.agent);
      }

      const agents = dedupeByResolvedName(candidateAgents, warnRegistry);

      const warning = reportInertUsage(aggregateInertUsage(perFileResults), warnRegistry);
      if (warning) console.warn(warning);

      return agents;
    } catch (error) {
      const message = toErrorMessage(error);
      console.warn(`${WARN_PREFIX}unexpected error discovering agents in ${agentsDir}: ${message}`);
      return [];
    }
  });
}

function mergeOverrides(base: AgentOverrides, top: AgentOverrides): AgentOverrides {
  const merged: AgentOverrides = { ...base };
  for (const [agentName, partial] of Object.entries(top)) {
    merged[agentName] = { ...(merged[agentName] ?? {}), ...partial };
  }
  return merged;
}

export interface SubagentSettings {
  agentOverrides: AgentOverrides;
  /** Raw value from settings JSON; validated at use site by resolveConcurrency
      (same pattern as timeoutMs → resolveTimeoutMs). */
  concurrency?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettingsFile(settingsPath: string): Promise<SubagentSettings> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(settingsPath, "utf8");
  } catch {
    return { agentOverrides: {} };
  }

  try {
    const parsed = JSON.parse(raw);
    const primary = parsed?.["pi-simple-agents"];
    const legacy = parsed?.["subagents"];
    if (legacy !== undefined) {
      console.warn(
        `${WARN_PREFIX}"subagents" key in ${settingsPath} is deprecated; use "pi-simple-agents" instead`,
      );
    }
    const agentOverrides = primary?.agentOverrides ?? legacy?.agentOverrides;
    const concurrency = primary?.concurrency ?? legacy?.concurrency;
    if (agentOverrides !== undefined && !isPlainObject(agentOverrides)) {
      console.warn(
        `${WARN_PREFIX}"agentOverrides" in ${settingsPath} is not an object; ignoring it`,
      );
      return { agentOverrides: {}, concurrency };
    }
    return {
      agentOverrides: agentOverrides ?? {},
      concurrency,
    };
  } catch {
    console.warn(`${WARN_PREFIX}failed to parse settings file ${settingsPath}`);
    return { agentOverrides: {} };
  }
}

export function loadSettings(
  userSettingsPath: string,
  projectSettingsPath?: string,
  cache?: Map<string, CacheEntry<Promise<SubagentSettings>>>,
): Promise<SubagentSettings> {
  const cacheKey = `${userSettingsPath}::${projectSettingsPath ?? ""}`;

  return cachedPromise(cache, cacheKey, async (): Promise<SubagentSettings> => {
    const user = await readSettingsFile(userSettingsPath);
    if (!projectSettingsPath) {
      return user;
    }

    const project = await readSettingsFile(projectSettingsPath);
    return {
      agentOverrides: mergeOverrides(user.agentOverrides, project.agentOverrides),
      concurrency: project.concurrency ?? user.concurrency,
    };
  });
}

export interface InvocationOverride {
  model?: string;
  tools?: string[];
  skills?: string[];
}

export function applyInvocationOverride(
  agent: AgentConfig,
  override: InvocationOverride,
): AgentConfig {
  if (
    override.model === undefined
    && override.tools === undefined
    && override.skills === undefined
  ) {
    return agent;
  }

  const result: AgentConfig = { ...agent };
  if (override.model !== undefined) result.model = override.model;
  if (override.tools !== undefined) result.tools = override.tools;
  if (override.skills !== undefined) result.skills = override.skills;
  return result;
}

export function applyOverrides(
  agents: AgentConfig[],
  overrides: AgentOverrides,
): AgentConfig[] {
  return agents.map((agent) => {
    const override = overrides[agent.name];
    if (!override) return agent;
    return { ...agent, ...override };
  });
}
