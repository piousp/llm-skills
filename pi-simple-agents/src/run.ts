import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { parseAgentOutput } from "./parse-output.ts";

// Exported for the seam that verifies --append-system-prompt is wired through
// without spawning a real child process or a fake-child-process harness.
export function buildPiInvocation(
  agent: AgentConfig,
  task: string,
  runId: string,
): { command: string; args: string[]; promptPath?: string } {
  const args = ["--mode", "json", "-p", "--no-session"];

  let promptPath: string | undefined;
  if (agent.systemPrompt?.trim()) {
    promptPath = path.join(os.tmpdir(), `pi-simple-agents-prompt-${runId}.md`);
    fs.writeFileSync(promptPath, agent.systemPrompt, { mode: 0o600 });
    const flag = agent.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    args.push(flag, promptPath);
  }

  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
  if (agent.inheritProjectContext === false) args.push("--no-context-files");
  if (agent.model) args.push("--model", agent.model);

  const taskWithReads = agent.defaultReads?.length
    ? `Read these files first: ${agent.defaultReads.join(", ")}\n\n${task}`
    : task;
  args.push(`Task: ${taskWithReads}`);
  return { command: "pi", args, promptPath };
}

function cleanupPromptFile(promptPath: string | undefined): void {
  if (!promptPath) return;
  try {
    fs.unlinkSync(promptPath);
  } catch {
    // Best-effort cleanup: the file may not have been written, or may
    // already be gone. Never let cleanup mask the original result.
  }
}

// Pure priority-ordered decision: aborted > stderr text > exit code > signal.
// Extracted from the close handler so each branch is independently testable
// without driving a fake child process through every case.
export function failureMessage(
  code: number | null,
  killSignal: NodeJS.Signals | null,
  stderrText: string,
  aborted: boolean,
): string {
  if (aborted) return "run was aborted";
  if (stderrText) return stderrText;
  if (code !== null) return `process exited with code ${code}`;
  if (killSignal) return `killed by signal ${killSignal}`;
  return "process was killed (unknown signal)";
}

interface AgentRunResultBase {
  agent: string;
  task: string;
  durationMs: number;
}

export type AgentRunResult =
  | (AgentRunResultBase & { status: "success"; finalText?: string })
  | (AgentRunResultBase & { status: "error"; error: string });

// Minimal structural surface runAgent actually drives on the child process:
// stdout/stderr "data", "error"/"close" on the process itself, and kill().
// Narrower than Node's full ChildProcess so test fakes don't need to satisfy
// the entire real spawn() surface.
interface ChildLike {
  stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: Array<"ignore" | "pipe"> },
) => ChildLike;

export interface RunAgentOptions {
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  spawnFn?: SpawnLike;
  killGraceMs?: number;
}

type SettleFn = (result: AgentRunResult) => void;

interface AgentRunContext {
  agent: AgentConfig;
  task: string;
  startedAt: number;
}

function errorResult(ctx: AgentRunContext, error: string): AgentRunResult {
  return {
    agent: ctx.agent.name,
    task: ctx.task,
    status: "error",
    error,
    durationMs: Date.now() - ctx.startedAt,
  };
}

// Wires stdout (progress parsing) and stderr (buffering for failureMessage)
// data handlers onto the child. Reparses the whole accumulated stdout buffer
// on every chunk rather than just the new slice: --mode json events can be
// split across chunk boundaries, mirroring spawn.ts's stdout handler.
function wireOutputHandlers(
  child: ChildLike,
  onProgress: ((text: string) => void) | undefined,
): { getOutput: () => string; getStderr: () => string } {
  let output = "";
  let stderrOutput = "";
  let lastProgress: string | undefined;

  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");

    const { lastProgress: progress } = parseAgentOutput(output);
    if (progress !== undefined && progress !== lastProgress) {
      lastProgress = progress;
      onProgress?.(lastProgress);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrOutput += chunk.toString("utf8");
  });

  return { getOutput: () => output, getStderr: () => stderrOutput };
}

// Wires the child's "error" event (spawn-time or runtime process errors) to
// the shared settle path.
function wireErrorHandler(child: ChildLike, ctx: AgentRunContext, settleOnce: SettleFn): void {
  child.on("error", (err: Error) => {
    settleOnce(errorResult(ctx, err.message));
  });
}

// Wires the child's "close" event: success (exit code 0) parses the final
// answer out of the accumulated stdout; any other outcome is resolved via
// failureMessage's aborted > stderr > code > signal priority.
function wireCloseHandler(
  child: ChildLike,
  ctx: AgentRunContext,
  settleOnce: SettleFn,
  getOutput: () => string,
  getStderr: () => string,
  isAborted: () => boolean,
): void {
  child.on("close", (code: number | null, killSignal: NodeJS.Signals | null) => {
    if (code === 0) {
      const { finalText } = parseAgentOutput(getOutput());
      settleOnce({
        agent: ctx.agent.name,
        task: ctx.task,
        status: "success",
        finalText,
        durationMs: Date.now() - ctx.startedAt,
      });
      return;
    }

    const stderrText = getStderr().trim();
    const error = failureMessage(code, killSignal, stderrText, isAborted());
    settleOnce(errorResult(ctx, error));
  });
}

export function runAgent(
  agent: AgentConfig,
  task: string,
  options: RunAgentOptions,
): Promise<AgentRunResult> {
  const { cwd, spawnFn = nodeSpawn, onProgress, signal, killGraceMs = 3000 } = options;
  const startedAt = Date.now();
  const ctx: AgentRunContext = { agent, task, startedAt };

  return new Promise((resolve) => {
    let settled = false;
    let promptPath: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildLike;

    const clearKillTimer = () => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    };

    // Single settle path shared by every resolve site (pre-aborted-at-entry,
    // spawn-throw, the child's "error" event, and "close") so none of them can
    // skip the kill-timer/abort-listener teardown or the prompt file cleanup.
    const settleOnce: SettleFn = (result) => {
      if (settled) return;
      settled = true;
      clearKillTimer();
      signal?.removeEventListener("abort", onAbort);
      cleanupPromptFile(promptPath);
      resolve(result);
    };

    if (signal?.aborted) {
      settleOnce(errorResult(ctx, "run was aborted"));
      return;
    }

    const invocation = buildPiInvocation(agent, task, crypto.randomUUID());
    promptPath = invocation.promptPath;

    try {
      child = spawnFn(invocation.command, invocation.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settleOnce(errorResult(ctx, err instanceof Error ? err.message : String(err)));
      return;
    }

    signal?.addEventListener("abort", onAbort);

    const { getOutput, getStderr } = wireOutputHandlers(child, onProgress);
    wireErrorHandler(child, ctx, settleOnce);
    wireCloseHandler(child, ctx, settleOnce, getOutput, getStderr, () => signal?.aborted ?? false);
  });
}
