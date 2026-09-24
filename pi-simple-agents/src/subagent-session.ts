import { basename, dirname, join } from "node:path";
import type { AgentConfig } from "./agents.ts";
import { toErrorMessage } from "./warn.ts";

/**
 * Directory where a subagent run's session should be persisted so usage
 * dashboards that reconcile nested-agent sessions by path convention (a
 * pattern several /usage tools follow, not one specific extension) can
 * attribute the run's cost to it: <parent-session-file-without-ext>/
 * <runId>/run-<resultIndex>/. Returns undefined when the caller's own
 * session isn't persisted (no parent path to nest under).
 */
export function childSessionDir(
  callerSessionFile: string | undefined,
  runId: string,
  resultIndex: number,
): string | undefined {
  if (!callerSessionFile) return undefined;
  const sanitized = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  // Guards against "_"-only (degenerate) runIds and against "."/".." surviving
  // sanitization, which would otherwise resolve to the parent or grandparent
  // directory instead of a run-scoped one.
  const sanitizedRunId = /^[._]*$/.test(sanitized) ? "run" : sanitized;
  const parentDir = dirname(callerSessionFile);
  const parentName = basename(callerSessionFile, ".jsonl");
  return join(parentDir, parentName, sanitizedRunId, `run-${resultIndex}`);
}

export interface SessionManagerFactory<S> {
  forkFrom(sourcePath: string, targetCwd: string, sessionDir: string): S; // may throw
  atPath(sessionFile: string, cwd: string): S; // may throw
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
  childDir: string | undefined,
  factory: SessionManagerFactory<S>,
): SubagentSessionResult<S> {
  if (agent.defaultContext === "forked") {
    if (!callerSessionFile) {
      return {
        manager: factory.inMemory(cwd),
        warnings: [
          `${agent.name}: caller session is not persisted — falling back to fresh`,
        ],
      };
    }
    try {
      const manager = factory.forkFrom(callerSessionFile, cwd, childDir ?? "");
      return { manager, warnings: [] };
    } catch (error) {
      const message = toErrorMessage(error);
      return {
        manager: factory.inMemory(cwd),
        warnings: [`${agent.name}: failed to fork caller session — falling back to fresh: ${message}`],
      };
    }
  }

  if (!childDir) {
    return { manager: factory.inMemory(cwd), warnings: [] };
  }

  try {
    const manager = factory.atPath(join(childDir, "session.jsonl"), cwd);
    return { manager, warnings: [] };
  } catch (error) {
    const message = toErrorMessage(error);
    return {
      manager: factory.inMemory(cwd),
      warnings: [`${agent.name}: failed to persist subagent session — falling back to in-memory: ${message}`],
    };
  }
}
