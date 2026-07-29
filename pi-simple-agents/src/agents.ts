import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, type FrontmatterResult } from "./frontmatter.ts";
import { reportInertUsage } from "./claude-compat.ts";

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

export function discoverAgents(
  agentsDir: string,
  cache?: Map<string, CacheEntry<AgentConfig[]>>,
  warnRegistry?: Map<string, number>,
): AgentConfig[] {
  if (cache) {
    const cached = cache.get(agentsDir);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  const perFileResults: FrontmatterResult[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;

    const filePath = path.join(agentsDir, entry.name);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      console.warn(`pi-simple-agents: skipping unreadable file ${filePath}`);
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      console.warn(`pi-simple-agents: skipping unreadable file ${filePath}`);
      continue;
    }

    const result = parseFrontmatter(content);
    const { frontmatter, body, warnings } = result;
    perFileResults.push(result);

    for (const warning of warnings) {
      console.warn(`pi-simple-agents: ${filePath}: ${warning}`);
    }

    if (!frontmatter.name || !frontmatter.description) {
      console.warn(
        `pi-simple-agents: skipping ${filePath} — missing required "name" or "description"`,
      );
      continue;
    }

    agents.push({
      name: frontmatter.name,
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
    });
  }

  const warning = reportInertUsage(aggregateInertUsage(perFileResults), warnRegistry);
  if (warning) console.warn(warning);

  if (cache) {
    cache.set(agentsDir, { timestamp: Date.now(), data: agents });
  }

  return agents;
}

function readOverridesFile(settingsPath: string): AgentOverrides {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed?.["pi-simple-agents"]?.agentOverrides
      ?? parsed?.["subagents"]?.agentOverrides
      ?? {};
  } catch {
    console.warn(`pi-simple-agents: failed to parse settings file ${settingsPath}`);
    return {};
  }
}

function mergeOverrides(base: AgentOverrides, top: AgentOverrides): AgentOverrides {
  const merged: AgentOverrides = { ...base };
  for (const [agentName, partial] of Object.entries(top)) {
    merged[agentName] = { ...(merged[agentName] ?? {}), ...partial };
  }
  return merged;
}

export function loadOverrides(
  userSettingsPath: string,
  projectSettingsPath?: string,
  cache?: Map<string, CacheEntry<AgentOverrides>>,
): AgentOverrides {
  const cacheKey = `${userSettingsPath}::${projectSettingsPath ?? ""}`;
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const userOverrides = readOverridesFile(userSettingsPath);
  if (!projectSettingsPath) {
    if (cache) {
      cache.set(cacheKey, { timestamp: Date.now(), data: userOverrides });
    }
    return userOverrides;
  }

  const projectOverrides = readOverridesFile(projectSettingsPath);
  const merged = mergeOverrides(userOverrides, projectOverrides);

  if (cache) {
    cache.set(cacheKey, { timestamp: Date.now(), data: merged });
  }

  return merged;
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
