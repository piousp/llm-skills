import { createProgressTracker, initialTaskProgress, type ProgressTracker, type TaskProgress } from "./progress.ts";
import { toErrorMessage, WARN_PREFIX } from "./warn.ts";
import type { AgentRunResult } from "./run.ts";

export interface JobTask {
  readonly agent: string;
  readonly task: string;
}

/** Who asked for a cancellation: "user" (a specific `/subagents cancel <id>`) or "system" (cancelAll \u2014 shutdown, or the headless safety nets in extensions/index.ts). Carried from "cancelling" through to "cancelled" so the completion message can word it accurately (see src/job-messages.ts). */
export type CancelReason = "user" | "system";

export type JobState =
  | { readonly status: "running" }
  | { readonly status: "cancelling"; readonly reason: CancelReason }
  | { readonly status: "completed"; readonly settledAt: number; readonly result: AgentRunResult }
  | { readonly status: "cancelled"; readonly settledAt: number; readonly result: AgentRunResult; readonly reason: CancelReason }
  | { readonly status: "failed"; readonly settledAt: number; readonly error: string };

export interface JobSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly task: JobTask;
  readonly progress: TaskProgress;
  readonly state: JobState;
}

export type SettledJob = JobSnapshot & { readonly state: Extract<JobState, { settledAt: number }> };

export type JobRun = (io: { signal: AbortSignal; tracker: ProgressTracker }) => Promise<AgentRunResult>;

export interface JobRegistryDeps {
  now: () => number;
  onSettled: (job: SettledJob) => void;
  onChange: (jobs: readonly JobSnapshot[]) => void;
  maxRecent?: number;
}

export type CancelResult =
  | { readonly kind: "cancelling"; readonly job: JobSnapshot }
  | { readonly kind: "not-running"; readonly job: JobSnapshot }
  | { readonly kind: "not-found"; readonly id: string };

export interface JobRegistry {
  start(input: { runId: string; task: JobTask; run: JobRun }): JobSnapshot;
  /** Snapshot of the job with the given id, or undefined when unknown (also for ids pruned by maxRecent). */
  get(id: string): JobSnapshot | undefined;
  cancel(id: string): CancelResult;
  cancelAll(): void;
  shutdown(): void;
  list(): readonly JobSnapshot[];
  hasRunning(): boolean;
  whenIdle(): Promise<void>;
  /** Drops every settled job (running/cancelling ones are untouched). Returns the count removed. */
  clearFinished(): number;
}

const MAX_RECENT_JOBS = 50;
// "S" for "subagent job"; four digits so ids read as a stable-width label
// (S1001, S1002, …) rather than a counter that looks like an array index.
const FIRST_JOB_NUMBER = 1001;

function isSettled(state: JobState): state is Extract<JobState, { settledAt: number }> {
  return state.status === "completed" || state.status === "cancelled" || state.status === "failed";
}

export function isActive(state: JobState): boolean {
  return state.status === "running" || state.status === "cancelling";
}

interface JobRecord {
  id: string;
  runId: string;
  startedAt: number;
  task: JobTask;
  progress: TaskProgress;
  state: JobState;
  controller: AbortController;
}

function toSnapshot(record: JobRecord): JobSnapshot {
  return {
    id: record.id,
    runId: record.runId,
    startedAt: record.startedAt,
    task: record.task,
    progress: record.progress,
    state: record.state,
  };
}

function warn(message: string): void {
  console.warn(`${WARN_PREFIX}${message}`);
}

/**
 * In-memory registry of background subagent jobs: launches `run` detached
 * from the caller, tracks the run's progress, and settles each job into a
 * terminal `JobState` without ever rejecting `start()` itself. No
 * persistence — a process restart orphans whatever is in flight.
 */
export function createJobRegistry(deps: JobRegistryDeps): JobRegistry {
  const maxRecent = deps.maxRecent ?? MAX_RECENT_JOBS;
  const jobs = new Map<string, JobRecord>();
  let nextId = FIRST_JOB_NUMBER;
  let closed = false;
  let idleWaiters: Array<() => void> = [];

  function hasRunning(): boolean {
    for (const record of jobs.values()) {
      if (isActive(record.state)) return true;
    }
    return false;
  }

  function list(): readonly JobSnapshot[] {
    return [...jobs.values()].reverse().map(toSnapshot);
  }

  function emitChange(): void {
    if (closed) return;
    try {
      deps.onChange(list());
    } catch (err) {
      warn(`onChange handler threw: ${toErrorMessage(err)}`);
    }
  }

  function releaseIdleWaitersIfDone(): void {
    if (hasRunning()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function pruneFinished(): void {
    const finishedIdsNewestFirst = [...jobs.values()]
      .filter((r) => isSettled(r.state))
      .reverse()
      .map((r) => r.id);
    for (const id of finishedIdsNewestFirst.slice(maxRecent)) {
      jobs.delete(id);
    }
  }

  function finalizeSettle(record: JobRecord, state: Extract<JobState, { settledAt: number }>): void {
    record.state = state;
    // `whenIdle()` waiters must be released on every settle, closed or not —
    // only the onSettled/onChange *notifications* are suppressed post-shutdown
    // (emitChange already no-ops internally when closed). A whenIdle() caller
    // (e.g. the settle barrier, mid-wait during a shutdown) must still resolve
    // once the job it's waiting on actually finishes.
    if (!closed) {
      const settledJob: SettledJob = { ...toSnapshot(record), state };
      try {
        deps.onSettled(settledJob);
      } catch (err) {
        warn(`onSettled handler threw: ${toErrorMessage(err)}`);
      }
      pruneFinished();
    }
    emitChange();
    releaseIdleWaitersIfDone();
  }

  function start(input: { runId: string; task: JobTask; run: JobRun }): JobSnapshot {
    const id = `S${nextId}`;
    nextId += 1;
    const controller = new AbortController();
    const record: JobRecord = {
      id,
      runId: input.runId,
      startedAt: deps.now(),
      task: input.task,
      progress: initialTaskProgress(input.task.agent),
      state: { status: "running" },
      controller,
    };
    jobs.set(id, record);

    const tracker = createProgressTracker(input.task.agent, (progress) => {
      record.progress = progress;
      emitChange();
    });

    // Scheduled on a later microtask so start() always returns before `run`
    // begins — a synchronous throw inside `run` is caught here too.
    Promise.resolve()
      .then(() => input.run({ signal: controller.signal, tracker }))
      .then(
        (result) => {
          if (record.state.status === "cancelling") {
            finalizeSettle(record, { status: "cancelled", settledAt: deps.now(), result, reason: record.state.reason });
          } else {
            finalizeSettle(record, { status: "completed", settledAt: deps.now(), result });
          }
        },
        (err) => {
          finalizeSettle(record, { status: "failed", settledAt: deps.now(), error: toErrorMessage(err) });
        },
      );

    return toSnapshot(record);
  }

  function cancel(id: string): CancelResult {
    const record = jobs.get(id);
    if (!record) return { kind: "not-found", id };
    if (!isActive(record.state)) return { kind: "not-running", job: toSnapshot(record) };
    if (record.state.status === "running") {
      record.state = { status: "cancelling", reason: "user" };
      record.controller.abort();
      emitChange();
    }
    return { kind: "cancelling", job: toSnapshot(record) };
  }

  function cancelAll(): void {
    // Only a running->cancelling transition is a real change; re-processing a
    // job that's already cancelling (e.g. shutdown() called twice, or the
    // settle barrier's abort path firing after a user cancel) must not emit a
    // redundant onChange.
    let changed = false;
    for (const record of jobs.values()) {
      if (record.state.status !== "running") continue;
      record.state = { status: "cancelling", reason: "system" };
      record.controller.abort();
      changed = true;
    }
    if (changed) emitChange();
  }

  function shutdown(): void {
    cancelAll();
    closed = true;
  }

  function clearFinished(): number {
    const finishedIds = [...jobs.values()].filter((r) => isSettled(r.state)).map((r) => r.id);
    for (const id of finishedIds) jobs.delete(id);
    if (finishedIds.length > 0) emitChange();
    return finishedIds.length;
  }

  function whenIdle(): Promise<void> {
    if (!hasRunning()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function get(id: string): JobSnapshot | undefined {
    const record = jobs.get(id);
    return record ? toSnapshot(record) : undefined;
  }

  return { start, get, cancel, cancelAll, shutdown, list, hasRunning, whenIdle, clearFinished };
}

/**
 * Delays a no-UI session's settle (`agent_before_settle`) until every
 * background job finishes, so a headless run (`pi -p`, `--mode json`, or a
 * nested child session) never tears down before its subagent results can be
 * delivered. A no-op when the session has a UI — the widget/command surface
 * lets the user track jobs that outlive the current turn there instead.
 */
export function createSettleBarrier(
  jobs: Pick<JobRegistry, "hasRunning" | "whenIdle" | "cancelAll">,
): (event: unknown, ctx: { hasUI: boolean; signal: AbortSignal | undefined }) => Promise<void> {
  return async (_event, ctx) => {
    if (ctx.hasUI) return;
    if (!jobs.hasRunning()) return;

    const signal = ctx.signal;
    if (!signal) {
      await jobs.whenIdle();
      return;
    }

    await new Promise<void>((resolve) => {
      // Calling resolve() or removing an already-removed listener twice is
      // harmless, so no "already finished" guard is needed here.
      const finish = (): void => {
        // Drop the listener once whenIdle wins the race, so a later abort of
        // this same signal (e.g. a shutdown right after the jobs finished)
        // doesn't still call cancelAll() against jobs that already settled.
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        jobs.cancelAll();
        finish();
      };
      jobs.whenIdle().then(finish);

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
}
