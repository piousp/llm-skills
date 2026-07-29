import path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { resolveDefaultReads } from "./default-reads.ts";
import { filterSkillsByName } from "./skills-filter.ts";
import { WARN_PREFIX } from "./warn.ts";

export type MinimalLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface LoaderOptionsResult {
  options: MinimalLoaderOptions;
  warnings: string[];
}

interface OverrideResult<V> {
  override: V | undefined;
  warnings: string[];
}

function buildAgentsFilesOverride(
  agent: AgentConfig,
  cwd: string,
  homeDir: string,
): OverrideResult<MinimalLoaderOptions["agentsFilesOverride"]> {
  if (agent.defaultReads.length === 0) {
    return { override: undefined, warnings: [] };
  }

  const resolved = resolveDefaultReads(agent.defaultReads, cwd, homeDir);

  if (resolved.files.length === 0) {
    return { override: undefined, warnings: resolved.warnings };
  }

  const override: MinimalLoaderOptions["agentsFilesOverride"] = (base) => {
    const basePaths = new Set(base.agentsFiles.map((f) => f.path));
    const extras = resolved.files.filter((f) => !basePaths.has(f.path));
    return { agentsFiles: [...base.agentsFiles, ...extras] };
  };

  return { override, warnings: resolved.warnings };
}

function buildSkillsOverride(
  agent: AgentConfig,
): OverrideResult<MinimalLoaderOptions["skillsOverride"]> {
  if (agent.skills === undefined) {
    return { override: undefined, warnings: [] };
  }

  if (agent.inheritSkills === false) {
    return {
      override: undefined,
      warnings: [
        `agent "${agent.name}" sets both "skills" and "inheritSkills: false" (contradictory config); skills filter ignored`,
      ],
    };
  }

  const requestedSkills = agent.skills;
  const override: MinimalLoaderOptions["skillsOverride"] = (base) => {
    const filtered = filterSkillsByName(base.skills, requestedSkills);
    if (filtered.missing.length > 0) {
      console.warn(
        `${WARN_PREFIX}agent "${agent.name}" requested unknown skills: ${filtered.missing.join(", ")}`,
      );
    }
    return { skills: filtered.skills, diagnostics: base.diagnostics };
  };

  return { override, warnings: [] };
}

export function buildLoaderOptions(
  agent: AgentConfig,
  cwd: string,
  homeDir: string,
): LoaderOptionsResult {
  const agentsFiles = buildAgentsFilesOverride(agent, cwd, homeDir);
  const skills = buildSkillsOverride(agent);

  return {
    options: {
      cwd,
      agentDir: path.join(homeDir, ".pi", "agent"),
      noExtensions: agent.inheritExtensions === false,
      noSkills: agent.inheritSkills === false,
      noContextFiles: agent.inheritProjectContext === false,
      systemPromptOverride:
        agent.systemPromptMode === "replace" && agent.systemPrompt
          ? () => agent.systemPrompt
          : undefined,
      appendSystemPromptOverride:
        agent.systemPromptMode === "append" && agent.systemPrompt
          ? (base) => [...base, agent.systemPrompt]
          : undefined,
      agentsFilesOverride: agentsFiles.override,
      skillsOverride: skills.override,
    },
    warnings: [...agentsFiles.warnings, ...skills.warnings],
  };
}
