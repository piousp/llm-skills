import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { applyInvocationOverride } from "./agents.ts";
import { runAgentViaSdk, type AgentRunResult, type RunAgentViaSdkOptions } from "./run.ts";
import type { ProgressTracker } from "./progress.ts";
import { buildLoaderOptions } from "./loader-config.ts";
import { childSessionDir, createSubagentSessionManager } from "./subagent-session.ts";
import { invocationOverrideOf } from "./validate.ts";
import type { SubagentParams as ValidatedSubagentParams } from "./validate.ts";
import { emitWarnings } from "./warn.ts";

export const SESSION_MANAGER_FACTORY = {
  forkFrom: (s: string, t: string, d: string) => SessionManager.forkFrom(s, t, d),
  atPath: (f: string, c: string) => SessionManager.open(f, path.dirname(f), c),
  inMemory: (c: string) => SessionManager.inMemory(c),
};

// childSessionDir's run index. Always 0 now that a job runs exactly one
// task; kept as a named constant (not inlined) to preserve the "run-0"
// session path convention downstream usage tooling already reconciles
// against.
export const RUN_INDEX = 0;

export interface RunTaskOptions {
  cwd: string;
  signal: AbortSignal | undefined;
  modelRuntime: ModelRuntime;
  callerSessionFile: string | undefined;
  /** The subagent tool call's own toolCallId — the basis for this run's childSessionDir. */
  runId: string;
  mode: RunAgentViaSdkOptions["mode"];
  /** Test seam: defaults to the real createAgentSession. */
  createSession?: RunAgentViaSdkOptions["createSession"];
  /** Test seam: the home root the nested loader derives agentDir from
      (`path.join(homeDir, ".pi", "agent")`, src/loader-config.ts). The entry
      derives it from the effective agents dir's layout; direct callers (tests)
      pass a tmpdir. Defaults to the real os.homedir(). */
  homeDir?: string;
}

// Runs one task end-to-end: resource loader creation/reload, session manager
// creation, the SDK run, and progress tracking teardown. The tracker (owned
// by the background job that invoked this) receives tool-use progress (see
// src/progress.ts); the job registry's `onChange` turns that into the live
// widget/`/subagents` feed — there is no more direct line to this tool
// call's own `onUpdate`, since execute() has already returned by the time
// any of this runs.
export async function runSingleTask(
  t: ValidatedSubagentParams,
  agent: AgentConfig,
  tracker: ProgressTracker | undefined,
  options: RunTaskOptions,
): Promise<AgentRunResult> {
  const { cwd, signal, modelRuntime, callerSessionFile, runId, mode, createSession = createAgentSession, homeDir = os.homedir() } = options;
  const effectiveAgent = applyInvocationOverride(agent, invocationOverrideOf(t));
  let usage: AgentRunResult["usage"];

  try {
    // Q2: loader warnings (eager + skills-closure-appended during reload())
    // are emitted in ONE point, right after reload() resolves, before any
    // run work — the warnings array is live (see LoaderOptionsResult).
    const loaderOptions = buildLoaderOptions(effectiveAgent, cwd, homeDir);
    const resourceLoader = new DefaultResourceLoader(loaderOptions.options);
    await resourceLoader.reload();
    emitWarnings(loaderOptions.warnings);

    const { manager, warnings } = createSubagentSessionManager(
      effectiveAgent,
      callerSessionFile,
      cwd,
      childSessionDir(callerSessionFile, runId, RUN_INDEX),
      SESSION_MANAGER_FACTORY,
    );
    emitWarnings(warnings);

    const result = await runAgentViaSdk(
      effectiveAgent,
      t.task,
      {
        modelRuntime,
        signal,
        createSession,
        resourceLoader,
        sessionManager: manager,
        getModel: (provider, modelId) => modelRuntime.getModel(provider, modelId),
        onProgressEvent: tracker ? (event) => tracker.onEvent(event) : undefined,
        mode,
      },
    );
    usage = result.usage;
    return result;
  } finally {
    // usage is only set once runAgentViaSdk actually resolves; a throw before
    // that (e.g. resourceLoader.reload() rejecting) leaves it undefined, which
    // markTaskDone treats identically to the argument being omitted.
    tracker?.markTaskDone(usage);
  }
}
