import { buildJobsWidgetLines } from "./job-view.ts";
import type { ProgressTheme } from "./progress.ts";
import type { JobSnapshot } from "./background-jobs.ts";

export const JOBS_WIDGET_KEY = "pi-simple-agents:jobs";
const TICK_MS = 1000;

/** Structural subset of the host's UI context this controller needs. */
export interface JobWidgetUi {
  setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  theme: ProgressTheme;
}

export interface JobWidgetDeps {
  /** Returns undefined in non-interactive modes (no UI to render into). */
  getUi: () => JobWidgetUi | undefined;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface JobWidget {
  refresh(jobs: readonly JobSnapshot[]): void;
  dispose(): void;
}

// Renders the running-jobs widget via `ctx.ui.setWidget()` and keeps its
// elapsed-time column live with a self-rescheduling tick while at least one
// job is active. A no-op when the host has no UI (print/json mode, or a
// nested child session) — there's nothing to render into.
export function createJobWidget(deps: JobWidgetDeps): JobWidget {
  let lastJobs: readonly JobSnapshot[] = [];
  let tickHandle: unknown;

  function stopTicking(): void {
    if (tickHandle !== undefined) {
      deps.cancel(tickHandle);
      tickHandle = undefined;
    }
  }

  function render(ui: JobWidgetUi): string[] | undefined {
    const lines = buildJobsWidgetLines(lastJobs, deps.now(), ui.theme);
    ui.setWidget(JOBS_WIDGET_KEY, lines, { placement: "belowEditor" });
    return lines;
  }

  // Shared by tick() and refresh(): render into the widget, then either keep
  // the elapsed-time column ticking (one job still active) or stop (nothing
  // left to show). Scheduling a tick only when none is already pending keeps
  // a single tick loop running per widget, however many times refresh() is
  // called while one job is active.
  function scheduleOrStop(lines: string[] | undefined): void {
    if (lines === undefined) {
      stopTicking();
      return;
    }
    if (tickHandle === undefined) tickHandle = deps.schedule(tick, TICK_MS);
  }

  function tick(): void {
    tickHandle = undefined; // this invocation already consumed the scheduled handle
    const ui = deps.getUi();
    scheduleOrStop(ui ? render(ui) : undefined);
  }

  function refresh(jobs: readonly JobSnapshot[]): void {
    lastJobs = jobs;
    const ui = deps.getUi();
    scheduleOrStop(ui ? render(ui) : undefined);
  }

  function dispose(): void {
    stopTicking();
    deps.getUi()?.setWidget(JOBS_WIDGET_KEY, undefined);
  }

  return { refresh, dispose };
}
