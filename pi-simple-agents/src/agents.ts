import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  defaultReads: string[];
  source: "user";
  filePath: string;
  systemPrompt: string;
}

export interface AgentOverrides {
  [agentName: string]: Partial<AgentConfig>;
}

export function discoverAgents(agentsDir: string): AgentConfig[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];

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

    const { frontmatter, body } = parseFrontmatter(content);

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
      model: frontmatter.model,
      systemPromptMode: frontmatter.systemPromptMode ?? "append",
      inheritProjectContext: frontmatter.inheritProjectContext ?? true,
      defaultReads: frontmatter.defaultReads ?? [],
      source: "user",
      filePath,
      systemPrompt: body.trim(),
    });
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
    return parsed?.["pi-simple-agents"]?.agentOverrides ?? {};
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
): AgentOverrides {
  const userOverrides = readOverridesFile(userSettingsPath);
  if (!projectSettingsPath) return userOverrides;

  const projectOverrides = readOverridesFile(projectSettingsPath);
  return mergeOverrides(userOverrides, projectOverrides);
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
