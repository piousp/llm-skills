import path from "node:path";
import {
  discoverAgents,
  loadSettings,
  applyOverrides,
  type AgentConfig,
  type CacheEntry,
  type SubagentSettings,
} from "./agents.ts";
import { resolveConcurrency } from "./run.ts";

export interface LoadedAgents {
  /** Overrides already applied. Treat as immutable. */
  agents: readonly AgentConfig[];
  /** Already resolved via resolveConcurrency; always a valid integer ≥ 1. */
  concurrency: number;
}

export interface AgentRegistry {
  /** Async, TTL-cached (5s, inherited from the underlying loaders),
      in-flight-deduped, never rejects. Updates the peek snapshot for `cwd`
      on completion. */
  load(cwd: string): Promise<LoadedAgents>;
  /** Sync, zero I/O. Last COMPLETED load for exactly this cwd, or undefined.
      May be arbitrarily stale; freshness is driven by load() callers. */
  peek(cwd: string): LoadedAgents | undefined;
}

export interface AgentRegistryPaths {
  agentsDir: string;
  userSettingsPath: string;
}

/** No I/O at construction. Project settings path is derived internally as
    path.join(cwd, ".pi", "settings.json") — package convention, one
    implementation, no injection point (YAGNI). */
export function createAgentRegistry(paths: AgentRegistryPaths): AgentRegistry {
  const agentsCache = new Map<string, CacheEntry<Promise<AgentConfig[]>>>();
  const settingsCache = new Map<string, CacheEntry<Promise<SubagentSettings>>>();
  const warnRegistry = new Map<string, number>();
  const snapshots = new Map<string, LoadedAgents>();

  async function load(cwd: string): Promise<LoadedAgents> {
    const projectSettingsPath = path.join(cwd, ".pi", "settings.json");

    const [discovered, settings] = await Promise.all([
      discoverAgents(paths.agentsDir, agentsCache, warnRegistry),
      loadSettings(paths.userSettingsPath, projectSettingsPath, settingsCache),
    ]);

    const agents = applyOverrides(discovered, settings.agentOverrides);
    const concurrency = resolveConcurrency(settings.concurrency);

    const result: LoadedAgents = { agents, concurrency };
    snapshots.set(cwd, result);
    return result;
  }

  function peek(cwd: string): LoadedAgents | undefined {
    return snapshots.get(cwd);
  }

  return { load, peek };
}
