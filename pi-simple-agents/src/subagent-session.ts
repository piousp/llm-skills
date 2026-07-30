import type { AgentConfig } from "./agents.ts";
import { toErrorMessage } from "./warn.ts";

export interface SessionManagerFactory<S> {
  forkFrom(sourcePath: string, targetCwd: string, sessionDir: string): S; // may throw
  inMemory(cwd: string): S;
}

export interface SubagentSessionResult<S> {
  manager: S;
  warnings: string[];
}

export function createSubagentSessionManager<S>(
  agent: Pick<AgentConfig, "name" | "defaultContext">,
  callerSessionFile: string | undefined,
  cwd: string,
  sessionDir: string,
  factory: SessionManagerFactory<S>,
): SubagentSessionResult<S> {
  if (agent.defaultContext !== "forked") {
    return { manager: factory.inMemory(cwd), warnings: [] };
  }

  if (!callerSessionFile) {
    return {
      manager: factory.inMemory(cwd),
      warnings: [
        `${agent.name}: caller session is not persisted — falling back to fresh`,
      ],
    };
  }

  try {
    const manager = factory.forkFrom(callerSessionFile, cwd, sessionDir);
    return { manager, warnings: [] };
  } catch (error) {
    const message = toErrorMessage(error);
    return {
      manager: factory.inMemory(cwd),
      warnings: [`${agent.name}: failed to fork caller session — falling back to fresh: ${message}`],
    };
  }
}
