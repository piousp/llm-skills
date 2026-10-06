import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { AgentConfig } from "./agents.ts";
import { toErrorMessage } from "./warn.ts";

// Most filesystems reject a single path component over 255 bytes
// (NAME_MAX) with ENAMETOOLONG. The host's own toolCallId is usually short
// (e.g. Anthropic's `toolu_...`), but nothing guarantees that, so the
// sanitized runId segment below is capped well under that limit \u2014 plus
// room for the "run-<N>"/"session.jsonl" suffix this directory still needs
// to hold.
const MAX_RUN_ID_SEGMENT_LENGTH = 64;

// Each level of subagent nesting (a subagent dispatching another subagent)
// adds one more "<runId>/run-<N>/session" segment to the path, via
// dirname/basename of the immediate parent's own session file. Confirmed in
// the wild: real session paths with ~20 nesting levels reached 1005-1016
// bytes, right at macOS's PATH_MAX (1024) / Linux's lower bound. Beyond
// this many literal levels, every further level of nesting collapses into
// one short hashed segment anchored at the ancestor directory that existed
// when the cap was first reached (see truncateAtDepth/childSessionDir
// below), so the path's length stops depending on how deep the real call
// chain goes.
const MAX_LITERAL_NESTING_DEPTH = 4;

const RUN_SEGMENT_PATTERN = /\/run-\d+/g;

function nestingDepth(sessionFile: string): number {
  return (sessionFile.match(RUN_SEGMENT_PATTERN) ?? []).length;
}

// Truncates `sessionFile` right after its `depth`-th "/run-<N>" segment.
// Every path with at least `depth` such segments collapses to the exact
// same prefix this way \u2014 the stable anchor every deeper descendant of the
// same branch reuses, which is what keeps the collapsed path bounded no
// matter how many further levels of nesting occur beyond it.
function truncateAtDepth(sessionFile: string, depth: number): string {
  RUN_SEGMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = RUN_SEGMENT_PATTERN.exec(sessionFile)) !== null) {
    count += 1;
    if (count === depth) return sessionFile.slice(0, match.index + match[0].length);
  }
  return sessionFile;
}

/**
 * Directory where a subagent run's session should be persisted so usage
 * dashboards that reconcile nested-agent sessions by path convention (a
 * pattern several /usage tools follow, not one specific extension) can
 * attribute the run's cost to it: <parent-session-file-without-ext>/
 * <runId>/run-<resultIndex>/. Returns undefined when the caller's own
 * session isn't persisted (no parent path to nest under). Beyond
 * MAX_LITERAL_NESTING_DEPTH levels of subagent-calling-subagent nesting,
 * the path collapses instead of continuing to grow (see
 * MAX_LITERAL_NESTING_DEPTH above).
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
  const sanitizedRunId = /^[._]*$/.test(sanitized) ? "run" : boundRunIdSegment(sanitized);

  if (nestingDepth(callerSessionFile) < MAX_LITERAL_NESTING_DEPTH) {
    const parentDir = dirname(callerSessionFile);
    const parentName = basename(callerSessionFile, ".jsonl");
    return join(parentDir, parentName, sanitizedRunId, `run-${resultIndex}`);
  }

  const anchor = truncateAtDepth(callerSessionFile, MAX_LITERAL_NESTING_DEPTH);
  const collapsedHash = createHash("sha1").update(`${callerSessionFile}\0${sanitizedRunId}`).digest("hex").slice(0, 16);
  return join(anchor, `deep-${collapsedHash}`, `run-${resultIndex}`);
}

// Keeps the segment well under NAME_MAX regardless of how long the host's
// own runId is. A short stable hash of the sanitized (pre-truncation) runId
// is appended on truncation, so two long runIds that happen to share a
// prefix don't collide into the same directory.
function boundRunIdSegment(sanitized: string): string {
  if (sanitized.length <= MAX_RUN_ID_SEGMENT_LENGTH) return sanitized;
  const hash = createHash("sha1").update(sanitized).digest("hex").slice(0, 8);
  return `${sanitized.slice(0, MAX_RUN_ID_SEGMENT_LENGTH - hash.length - 1)}_${hash}`;
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

function fallbackToInMemory<S>(cwd: string, factory: SessionManagerFactory<S>, warning: string): SubagentSessionResult<S> {
  return { manager: factory.inMemory(cwd), warnings: [warning] };
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
      return fallbackToInMemory(cwd, factory, `${agent.name}: caller session is not persisted — falling back to fresh`);
    }
    try {
      const manager = factory.forkFrom(callerSessionFile, cwd, childDir ?? "");
      return { manager, warnings: [] };
    } catch (error) {
      return fallbackToInMemory(
        cwd,
        factory,
        `${agent.name}: failed to fork caller session — falling back to fresh: ${toErrorMessage(error)}`,
      );
    }
  }

  if (!childDir) {
    return { manager: factory.inMemory(cwd), warnings: [] };
  }

  try {
    const manager = factory.atPath(join(childDir, "session.jsonl"), cwd);
    return { manager, warnings: [] };
  } catch (error) {
    return fallbackToInMemory(
      cwd,
      factory,
      `${agent.name}: failed to persist subagent session — falling back to in-memory: ${toErrorMessage(error)}`,
    );
  }
}
