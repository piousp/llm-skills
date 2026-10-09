import path from "node:path";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { resolveDefaultReads } from "./default-reads.ts";
import { filterSkillsByName } from "./skills-filter.ts";
import { WARN_PREFIX } from "./warn.ts";

export type MinimalLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface LoaderOptionsResult {
  options: MinimalLoaderOptions;
  /** Live warnings sink: entries appended by the override closures during
      DefaultResourceLoader.reload() land in this same array — runSingleTask
      emits it after reload() resolves (Q2: one emission point). */
  warnings: string[];
}

interface OverrideResult<V> {
  override: V | undefined;
  warnings: string[];
}

// pi's CLI injects its built-in extensions into its own loader (main.js:
// builtInExtensions); SDK loaders get none unless supplied here. Marked
// builtin/replaceable exactly like the CLI (flags copied by hand, verified
// against pi 0.99.1), so `-builtin:<name>` settings,
// noExtensions, and an installed extension registering the same tool or
// command (`codemode`, `tool_search`, `/mcp`) behave the same in subagents
// as in the host. llama.cpp is omitted: its factory
// isn't exported, and it registers a provider, not tools.
const BUILTIN_EXTENSION_FACTORIES: MinimalLoaderOptions["extensionFactories"] = [
  { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
  { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
  { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];

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
  warnings: string[],
): { override: MinimalLoaderOptions["skillsOverride"] } {
  if (agent.skills === undefined) {
    return { override: undefined };
  }

  if (agent.inheritSkills === false) {
    warnings.push(
      `agent "${agent.name}" sets both "skills" and "inheritSkills: false" (contradictory config); skills filter ignored`,
    );
    return { override: undefined };
  }

  const requestedSkills = agent.skills;
  const override: MinimalLoaderOptions["skillsOverride"] = (base) => {
    const filtered = filterSkillsByName(base.skills, requestedSkills);
    if (filtered.missing.length > 0) {
      // Q2: appended to the live warnings sink (the same array
      // buildLoaderOptions returns); emitted post-reload by runSingleTask.
      warnings.push(
        `${WARN_PREFIX}agent "${agent.name}" requested unknown skills: ${filtered.missing.join(", ")}`,
      );
    }
    return { skills: filtered.skills, diagnostics: base.diagnostics };
  };

  return { override };
}

export function buildLoaderOptions(
  agent: AgentConfig,
  cwd: string,
  homeDir: string,
): LoaderOptionsResult {
  const agentsFiles = buildAgentsFilesOverride(agent, cwd, homeDir);
  const warnings: string[] = [...agentsFiles.warnings];
  const skills = buildSkillsOverride(agent, warnings);

  return {
    options: {
      cwd,
      agentDir: path.join(homeDir, ".pi", "agent"),
      noExtensions: agent.inheritExtensions === false,
      extensionFactories: BUILTIN_EXTENSION_FACTORIES,
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
      noThemes: true,
    },
    warnings,
  };
}
