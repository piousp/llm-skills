import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPeekLines,
  PeekOverlayComponent,
  createPeekManager,
  type PeekKeybindings,
  type PeekManagerUi,
  type PeekOverlayDeps,
  type PeekRenderPrefs,
  type PeekTheme,
} from "../../src/peek-window.ts";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { formatRunUsage } from "../../src/usage.ts";
import { WARN_PREFIX } from "../../src/warn.ts";
import type { JobSnapshot } from "../../src/background-jobs.ts";
import { type EntryDraft, type TranscriptEntry, type TranscriptState } from "../../src/transcript.ts";

const theme: PeekTheme = { fg: (c, t) => `<${c}>${t}</${c}>` };

// Strips the fake-theme tags so a line's visible width can be asserted (the
// real renderer's truncateToWidth guard sees the same visible width).
function visible(line: string): string {
  return line.replace(/<[^>]+>/g, "");
}

function runningJob(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "S1001",
    runId: "call-1",
    startedAt: 0,
    task: { agent: "scout", task: "look around the repo" },
    progress: { agent: "scout", runningTools: [], history: [], done: false },
    state: { status: "running" },
    ...overrides,
  };
}

// Hand-built TranscriptState: peek rendering is a pure view over the state
// shape, so the tests build it directly instead of folding raw events.
// Entries are drafted as the exported EntryDraft union (an Omit over the
// union would collapse it to a common-property intersection).
let nextSeq = 0;
function entry(e: EntryDraft): TranscriptEntry {
  return { ...e, seq: nextSeq++ } as TranscriptEntry;
}

function state(
  entries: TranscriptEntry[],
  opts: { currentText?: string; currentThinking?: string; dropped?: number } = {},
): TranscriptState {
  return {
    entries,
    currentText: opts.currentText ?? "",
    currentThinking: opts.currentThinking ?? "",
    dropped: opts.dropped ?? 0,
    chars: 0,
  };
}

function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

// --- buildPeekLines ---

test("buildPeekLines: frame has a titled top border; header has id, agent, status and elapsed; footer closes with Esc/q and w", () => {
  const linesOut = buildPeekLines(runningJob(), state([]), 5_000, theme, 80, false);

  // The fake theme wraps the title in accent tags; the real renderer emits ANSI there.
  assert.match(linesOut[0], /^\u250c\u2500 <accent>peek \u00b7 S1001 \u00b7 scout<\/accent> \u2500+\u2510$/);
  assert.match(linesOut[1], /^\u2502 S1001 <accent>scout<\/accent> <accent>running<\/accent> \u00b7 5s.*\u2502$/);
  assert.match(linesOut[1], /^\u2502 .*\u2502$/);
  assert.match(linesOut.at(-2)!, /Esc\/q close/);
  assert.match(linesOut.at(-2)!, /w fullscreen/);
  assert.match(linesOut.at(-1)!, /^\u2514\u2500+\u2518$/);
});

test("buildPeekLines: every line fits the given width", () => {
  const long = "x".repeat(300);
  const transcript = state([entry({ kind: "text", content: long })], { currentText: long });
  const linesOut = buildPeekLines(runningJob(), transcript, 1_000, theme, 60, true);

  assert.ok(linesOut.length > 0);
  for (const line of linesOut) assert.ok(visible(line).length <= 60, `too wide: ${visible(line)}`);
});

test("buildPeekLines: header shows live usage from progress when present", () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, isSubscription: false, context: undefined };
  const job = runningJob({ progress: { agent: "scout", runningTools: [], history: [], done: false, usage } });
  // Wide width: the fake theme's <dim> tags count into truncateToWidth's
  // visible width, so the full usage footer needs room to survive the guard.
  const linesOut = buildPeekLines(job, state([]), 1_000, theme, 120, false);

  // Line 0 is the top border with the title; the header follows.
  assert.match(linesOut[1], new RegExp(formatRunUsage(usage).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("buildPeekLines: status colors — running accent, completed success, failed error", () => {
  const result = { agent: "scout", task: "t", durationMs: 1, status: "success" as const };
  // Line 1: the header sits under the titled top border (line 0).
  const running = buildPeekLines(runningJob(), state([]), 1_000, theme, 80, false)[1];
  const completed = buildPeekLines(
    runningJob({ state: { status: "completed", settledAt: 1_000, result } }),
    state([]), 2_000, theme, 80, false,
  )[1];
  const failed = buildPeekLines(
    runningJob({ state: { status: "failed", settledAt: 1_000, result: { agent: "scout", task: "t", durationMs: 1, status: "error" as const, error: "boom" } } }),
    state([]), 2_000, theme, 80, false,
  )[1];

  assert.match(running, /<accent>running<\/accent>/);
  assert.match(completed, /<success>completed<\/success>/);
  assert.match(failed, /<error>failed<\/error>/);
});

test("buildPeekLines: thinking entries render only the last 5 display lines with an ellipsis marker", () => {
  const transcript = state([
    entry({ kind: "text", content: "before" }),
    entry({ kind: "thinking", content: lines(8, "thought") }),
  ]);
  const linesOut = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false);
  const body = linesOut.slice(1, -1).join("\n");

  assert.match(body, /thought 8/); // the newest thinking line survives
  assert.match(body, /\u2026/); // the first visible tail line is marked
  assert.doesNotMatch(body, /thought 1\b/); // older thinking lines are gone
  assert.doesNotMatch(body, /thought 3\b/); // lines 1..3 dropped, 4..8 kept
  const thoughtLines = linesOut.filter((l) => l.includes("thought"));
  assert.equal(thoughtLines.length, 5);
});

test("buildPeekLines: text entries and tool entries render in order", () => {
  const transcript = state([
    entry({ kind: "text", content: "reading now" }),
    entry({ kind: "tool-start", toolCallId: "t1", label: "read a.ts" }),
    entry({ kind: "tool-end", toolCallId: "t1", ok: true, summary: "contents of a.ts" }),
    entry({ kind: "tool-end", toolCallId: "t2", ok: false, summary: "no such file" }),
  ]);
  const linesOut = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false);
  const body = linesOut.slice(1, -1);

  assert.match(body.join("\n"), /reading now/);
  assert.match(body.join("\n"), /\u25b8 read a\.ts/);
  assert.match(body.join("\n"), /\u25aa contents of a\.ts/);
  assert.match(body.find((l) => l.includes("no such file"))!, /<error>/); // failed tool result in error color
});

test("buildPeekLines: live currentText renders after the entries", () => {
  const transcript = state([entry({ kind: "text", content: "settled paragraph" })], {
    currentText: "streaming right now",
  });
  const linesOut = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false);
  const body = linesOut.join("\n");

  assert.match(body, /settled paragraph/);
  assert.match(body, /streaming right now/);
  assert.ok(body.indexOf("settled paragraph") < body.indexOf("streaming right now"));
});

test("buildPeekLines: body beyond 24 lines is tail-sliced with an elision line", () => {
  const transcript = state([entry({ kind: "text", content: lines(30) })]);
  const linesOut = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false);

  // top/bottom borders + header + elision + 24 body lines + footer
  assert.equal(linesOut.length, 2 + 1 + 1 + 24 + 1);
  assert.match(linesOut[2], /\(\+6 earlier\)/);
  assert.match(linesOut.join("\n"), /line 30/); // the newest lines survive
  assert.doesNotMatch(linesOut.join("\n"), /line 5\b/);
});

test("buildPeekLines: dropped entry count feeds the elision line", () => {
  const transcript = state([entry({ kind: "text", content: lines(30) })], { dropped: 3 });
  const linesOut = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false);

  assert.match(linesOut[2], /\(\+9 earlier\)/);
});

test("buildPeekLines: a settled job freezes to its result line (no live tails)", () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, isSubscription: false, context: undefined };
  const result = { agent: "scout", task: "t", durationMs: 1, status: "success" as const, finalText: "done", usage };
  const job = runningJob({ state: { status: "completed", settledAt: 4_000, result } });
  const transcript = state([entry({ kind: "text", content: "body text" })], { currentText: "streaming" });
  const linesOut = buildPeekLines(job, transcript, 9_000, theme, 80, false);
  const body = linesOut.join("\n");

  assert.match(body, /<accent>scout<\/accent> \u2014 success/); // buildFinishedTaskLine shape
  assert.match(body, new RegExp(formatRunUsage(usage).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(body, /streaming/); // settled state froze: no live tail
  assert.match(body, /body text/); // transcript entries still shown
});

test("buildPeekLines: a settled job's header freezes elapsed at settledAt, even re-opened far later", () => {
  const result = { agent: "scout", task: "t", durationMs: 1, status: "success" as const };
  const job = runningJob({ state: { status: "completed", settledAt: 4_000, result } });
  const linesOut = buildPeekLines(job, state([]), 40_000, theme, 80, false);

  assert.match(linesOut[1]!, /\u00b7 4s\b/); // settledAt - startedAt: frozen at settle time
  assert.doesNotMatch(linesOut[1]!, /40s/); // not recomputed from `now`
});

test("buildPeekLines: a failed settled job shows FAILED plus its usage", () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, isSubscription: false, context: undefined };
  const job = runningJob({
    state: { status: "failed", settledAt: 4_000, result: { agent: "scout", task: "t", durationMs: 1, status: "error" as const, error: "boom", usage } },
  });
  const linesOut = buildPeekLines(job, state([]), 9_000, theme, 80, false);

  assert.match(linesOut.join("\n"), /FAILED/);
  assert.match(linesOut.join("\n"), new RegExp(formatRunUsage(usage).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("buildPeekLines: an errored settled job shows the error text instead of a result line", () => {
  const job = runningJob({ state: { status: "errored", settledAt: 4_000, error: "crashed unexpectedly" } });
  const linesOut = buildPeekLines(job, state([]), 9_000, theme, 80, false);

  assert.match(linesOut.join("\n"), /crashed unexpectedly/);
  assert.doesNotMatch(linesOut.join("\n"), /FAILED/);
});

test("buildPeekLines: a cancelled settled job shows its result line", () => {
  const result = { agent: "scout", task: "t", durationMs: 1, status: "success" as const, finalText: "partial" };
  const job = runningJob({ state: { status: "cancelled", settledAt: 4_000, result, reason: "user" } });
  const linesOut = buildPeekLines(job, state([]), 9_000, theme, 80, false);

  assert.match(linesOut.join("\n"), /\u2014 success/);
});

test("buildPeekLines: an empty transcript falls back to the task's first line", () => {
  const linesOut = buildPeekLines(runningJob(), state([]), 1_000, theme, 80, false);

  assert.match(linesOut.join("\n"), /<dim>look around the repo<\/dim>/);
});

test("buildPeekLines: an undefined transcript falls back the same way", () => {
  const linesOut = buildPeekLines(runningJob(), undefined, 1_000, theme, 80, false);

  assert.match(linesOut.join("\n"), /look around the repo/);
});

test("buildPeekLines: an empty transcript with dropped entries keeps the elision hint", () => {
  const linesOut = buildPeekLines(runningJob(), state([], { dropped: 7 }), 1_000, theme, 80, false);

  assert.match(linesOut.join("\n"), /\(\+7 earlier\)/);
  assert.match(linesOut.join("\n"), /look around the repo/);
});

// --- buildPeekLines render prefs ---

test("buildPeekLines: hideThinking renders no thinking at all \u2014 entries, ellipse tail, and live tail", () => {
  const transcript = state([
    entry({ kind: "text", content: "before" }),
    entry({ kind: "thinking", content: lines(8, "thought") }),
  ], { currentThinking: "live thought" });
  const linesOut = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false, { hideThinking: true });
  const frame = linesOut.join("\n");

  assert.doesNotMatch(frame, /thought/); // no thinking body, no live tail
  assert.match(frame, /before/); // the rest of the body is untouched
  // The only ellipsis left would be the thinking tail marker; this small
  // body does not even get an elision line.
  assert.equal(linesOut.filter((l) => l.includes("\u2026") && !l.includes("earlier")).length, 0);
});

test("buildPeekLines: toolsExpanded=false omits tool-end lines and keeps tool-start plus the settled result", () => {
  const transcript = state([
    entry({ kind: "tool-start", toolCallId: "t1", label: "read a.ts" }),
    entry({ kind: "tool-end", toolCallId: "t1", ok: true, summary: "contents of a.ts" }),
    entry({ kind: "tool-end", toolCallId: "t2", ok: false, summary: "no such file" }),
  ]);
  const result = { agent: "scout", task: "t", durationMs: 1, status: "error" as const, error: "boom" };
  const job = runningJob({ state: { status: "failed", settledAt: 1_000, result } });
  const linesOut = buildPeekLines(job, transcript, 9_000, theme, 80, false, { toolsExpanded: false });
  const frame = linesOut.join("\n");

  assert.doesNotMatch(frame, /\u25aa/); // collapsed tools hide their results
  assert.match(frame, /\u25b8 read a\.ts/); // tool-start lines stay
  assert.match(frame, /FAILED/); // the settled outcome still shows below the body
});

// --- buildPeekLines scroll ---

test("buildPeekLines: scroll mode at offset 0 stays byte-identical to follow mode", () => {
  const transcript = state([entry({ kind: "text", content: lines(30) })]);
  const follow = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false);
  const scrolled = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false, undefined, { offset: 0 });

  assert.deepEqual(scrolled, follow);
});

test("buildPeekLines: a negative scroll offset clamps to follow mode", () => {
  const transcript = state([entry({ kind: "text", content: lines(30) })]);
  const follow = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false);
  const negative = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false, undefined, { offset: -5 });

  assert.deepEqual(negative, follow);
});

test("buildPeekLines: scrolling up shows older body lines, grows the elision count, and slides the newest off", () => {
  const transcript = state([entry({ kind: "text", content: lines(30) })]);
  // offset 3: the window becomes lines 4..27; the three lines hidden above
  // it elide into the marker (nothing was dropped by the ring buffer here).
  const scrolled = buildPeekLines(runningJob(), transcript, 1_000, theme, 80, false, undefined, { offset: 3 });
  const body = scrolled.join("\n");

  assert.match(body, /\u0028\+3 earlier\u0029/);
  assert.match(body, /line 4\b/); // the first line hidden in follow mode is now visible
  assert.doesNotMatch(body, /line 28\b/); // the newest lines scrolled away
});

test("buildPeekLines: the footer gains the scroll hint only when the body outgrows the window", () => {
  const long = buildPeekLines(runningJob(), state([entry({ kind: "text", content: lines(30) })]), 1_000, theme, 80, false);
  const short = buildPeekLines(runningJob(), state([entry({ kind: "text", content: "one line" })]), 1_000, theme, 80, false);

  assert.match(long.at(-2)!, /\u2191\/\u2193 scroll/);
  assert.doesNotMatch(short.at(-2)!, /scroll/);
});

// --- PeekOverlayComponent ---

function fakeScheduler() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    schedule: (fn: () => void, _ms: number) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    cancel: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire(handle: number) {
      const fn = pending.get(handle);
      pending.delete(handle);
      fn?.();
    },
    pendingCount: () => pending.size,
  };
}

function fakeTui() {
  const renders: number[] = [];
  return { tui: { requestRender: () => void renders.push(1) }, renders };
}

// The real KeybindingsManager resolves Esc to tui.select.cancel; the fake
// matches only that action, so "esc" is indistinguishable from any other
// data — exactly the seam handleInput relies on.
const keybindings: PeekKeybindings = {
  // The real matcher pairs the action with the incoming data; a fake keyed
  // only on the action would match EVERY key and close the window on w.
  matches: (data, action) => data === "esc" && action === "tui.select.cancel",
};

function mount(
  jobRef: { current: JobSnapshot | undefined },
  extra: Partial<PeekOverlayDeps> = {},
  kb: PeekKeybindings = keybindings,
) {
  const scheduler = fakeScheduler();
  const { tui, renders } = fakeTui();
  const doneResults: Array<"toggle" | undefined> = [];
  const component = new PeekOverlayComponent(tui, theme, kb, (r) => doneResults.push(r), {
    getJob: () => jobRef.current,
    getTranscript: () => state([entry({ kind: "text", content: "hi" })]),
    now: () => 1_000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    fullscreen: false,
    ...extra,
  });
  return { component, scheduler, renders, doneResults };
}

// Scroll-key fake: the real keybindings resolve the arrow/page keys to these
// select actions; the fake answers for exactly the actions handleInput asks.
const scrollKeybindings: PeekKeybindings = {
  matches: (data, action) =>
    (data === "esc" && action === "tui.select.cancel") ||
    (data === "up" && action === "tui.select.up") ||
    (data === "down" && action === "tui.select.down") ||
    (data === "pageup" && action === "tui.select.pageUp") ||
    (data === "pagedown" && action === "tui.select.pageDown"),
};

// Normalized wheel event as pi-tui would deliver it (negative delta = up).
function wheelEvent(delta: number): TuiMouseEvent {
  return {
    type: "wheel",
    button: "none",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: delta,
  };
}

function pressEvent(): TuiMouseEvent {
  return {
    type: "press",
    button: "left",
    x: 3,
    y: 3,
    screenX: 3,
    screenY: 3,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

// A 30-body-line transcript: follow shows lines 7..30 (plus the elision
// marker), so the scroll cap is 6.
function scrollTranscript(): TranscriptState {
  return state([entry({ kind: "text", content: lines(30) })]);
}

test("PeekOverlayComponent: Esc (via keybindings) closes — done(undefined) and the pulse stops", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const { component, scheduler, doneResults } = mount(jobRef);

  component.handleInput("esc");

  assert.deepEqual(doneResults, [undefined]);
  assert.equal(scheduler.pendingCount(), 0);
});

test("PeekOverlayComponent: q closes the same way", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const { component, scheduler, doneResults } = mount(jobRef);

  component.handleInput("q");

  assert.deepEqual(doneResults, [undefined]);
  assert.equal(scheduler.pendingCount(), 0);
});

test("PeekOverlayComponent: w requests the mode toggle — done(\"toggle\")", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const { component, doneResults } = mount(jobRef);

  component.handleInput("w");

  assert.deepEqual(doneResults, ["toggle"]);
});

test("PeekOverlayComponent: other input is ignored", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const { component, scheduler, doneResults } = mount(jobRef);

  component.handleInput("x");

  assert.equal(doneResults.length, 0);
  assert.equal(scheduler.pendingCount(), 1); // still pulsing
});

test("PeekOverlayComponent: a pulse tick re-renders while the job is active and reschedules itself", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const { component, scheduler, renders } = mount(jobRef);

  scheduler.fire(1);

  assert.equal(renders.length, 1);
  assert.equal(scheduler.pendingCount(), 1);
  component.dispose();
});

test("PeekOverlayComponent: a tick that finds the job settled renders once more and stops the pulse", () => {
  const jobRef = {
    current: runningJob({
      state: { status: "completed" as const, settledAt: 1_000, result: { agent: "scout", task: "t", durationMs: 1, status: "success" as const } },
    }) as JobSnapshot | undefined,
  };
  const { component, scheduler, renders } = mount(jobRef);

  scheduler.fire(1);

  assert.equal(renders.length, 1);
  assert.equal(scheduler.pendingCount(), 0); // no reschedule after settling
});

test("PeekOverlayComponent: a tick that finds the job pruned stops the pulse too", () => {
  const jobRef = { current: undefined as JobSnapshot | undefined };
  const { component, scheduler, renders } = mount(jobRef);

  scheduler.fire(1);

  assert.equal(renders.length, 1);
  assert.equal(scheduler.pendingCount(), 0);
  assert.match(component.render(80).join("\n"), /job finished and evicted/);
});

test("PeekOverlayComponent: render yields non-empty width-fitting lines with a footer", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const { component } = mount(jobRef);
  const linesOut = component.render(80);

  assert.ok(linesOut.length > 0);
  // Footer sits above the bottom border line.
  assert.match(linesOut.at(-2)!, /Esc\/q close/);
  for (const line of linesOut) assert.ok(visible(line).length <= 80);
});

test("PeekOverlayComponent: dispose stops the timer without calling done; a second dispose is a no-op", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const { component, scheduler, doneResults } = mount(jobRef);

  component.dispose();
  component.dispose();

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(doneResults.length, 0);
});

// --- PeekOverlayComponent render prefs ---

test("PeekOverlayComponent: render reads getPrefs live on every render \u2014 changes take effect immediately", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  let prefs: PeekRenderPrefs | undefined = { hideThinking: true };
  const { component } = mount(jobRef, {
    getTranscript: () =>
      state([entry({ kind: "text", content: "visible" }), entry({ kind: "thinking", content: "hidden once" })]),
    getPrefs: () => prefs,
  });

  assert.doesNotMatch(component.render(80).join("\n"), /hidden once/);

  prefs = undefined; // same instance, new prefs: thinking shows again
  assert.match(component.render(80).join("\n"), /hidden once/);
});

// --- PeekOverlayComponent scroll ---

test("PeekOverlayComponent: Up/PageUp scroll toward the past, Down/PageDn back, 0 re-engages follow", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const onScrolls: number[] = [];
  const { component } = mount(
    jobRef,
    { getTranscript: scrollTranscript, onScroll: (o) => onScrolls.push(o) },
    scrollKeybindings,
  );
  component.render(80); // mount render: fixes the scroll cap (30 - 24 = 6)

  component.handleInput("up"); // one line toward the past
  assert.deepEqual(onScrolls, [1]);
  component.handleInput("pageup"); // half the body capacity: +12 clamps at the cap
  assert.deepEqual(onScrolls, [1, 6]);
  component.handleInput("down"); // one line back toward the bottom
  assert.deepEqual(onScrolls, [1, 6, 5]);
  component.handleInput("pagedown"); // -12 clamps at 0: follow re-engages
  assert.deepEqual(onScrolls, [1, 6, 5, 0]);
});

test("PeekOverlayComponent: scrolling honours the cap \u2014 Up past the top of the body stays clamped", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const onScrolls: number[] = [];
  const { component } = mount(
    jobRef,
    { getTranscript: scrollTranscript, onScroll: (o) => onScrolls.push(o) },
    scrollKeybindings,
  );
  component.render(80); // cap = 6

  component.handleInput("pageup"); // +12 > cap 6
  assert.deepEqual(onScrolls, [6]);
  component.handleInput("up"); // already at the top: unchanged, still idempotently notified
  assert.deepEqual(onScrolls, [6, 6]);
});

test("PeekOverlayComponent: wheel events scroll \u2014 negative delta up, positive back; handled, not passed through", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const onScrolls: number[] = [];
  const { component } = mount(jobRef, { getTranscript: scrollTranscript, onScroll: (o) => onScrolls.push(o) });
  component.render(80); // cap = 6

  assert.deepEqual(component.handleMouse(wheelEvent(-3)), { handled: true } as TuiMouseEventResult);
  assert.deepEqual(onScrolls, [3]);
  assert.deepEqual(component.handleMouse(wheelEvent(3)), { handled: true } as TuiMouseEventResult);
  assert.deepEqual(onScrolls, [3, 0]); // back to the bottom: follow re-engages
});

test("PeekOverlayComponent: non-wheel mouse events are not handled (the main view keeps them)", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const onScrolls: number[] = [];
  const { component } = mount(jobRef, { getTranscript: scrollTranscript, onScroll: (o) => onScrolls.push(o) });

  assert.equal(component.handleMouse(pressEvent()), undefined);
  assert.deepEqual(onScrolls, []);
});

test("PeekOverlayComponent: scrolled rendering shows an older window, the newest slides off, Down re-follows", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const onScrolls: number[] = [];
  const { component } = mount(
    jobRef,
    { getTranscript: scrollTranscript, onScroll: (o) => onScrolls.push(o) },
    scrollKeybindings,
  );

  const follow = component.render(80).join("\n");
  assert.match(follow, /line 30/); // the live tail
  assert.match(follow, /\u0028\+6 earlier\u0029/);

  component.handleInput("up"); // offset 1: the window slides one line up
  const scrolled = component.render(80).join("\n");
  assert.match(scrolled, /line 6\b/); // an older line became visible
  assert.doesNotMatch(scrolled, /line 30/); // the newest slid off
  assert.match(scrolled, /\u0028\+5 earlier\u0029/); // +5 hidden above the window
  assert.match(component.render(80).at(-2)!, /\u2191/); // the scroll hint shows once scrollable

  component.handleInput("down"); // back to 0: the live tail resumes
  assert.equal(onScrolls.at(-1), 0);
  assert.match(component.render(80).join("\n"), /line 30/);
});

test("PeekOverlayComponent: short body \u2014 footer has no scroll hint and Up stays in follow mode", () => {
  const jobRef = { current: runningJob() as JobSnapshot | undefined };
  const onScrolls: number[] = [];
  const { component } = mount(jobRef, { onScroll: (o) => onScrolls.push(o) }, scrollKeybindings);

  const frame = component.render(80);
  assert.doesNotMatch(frame.at(-2)!, /scroll/);
  component.handleInput("up");
  assert.deepEqual(onScrolls, [0]); // clamped at the (0) cap: still following
});

// --- createPeekManager ---

function fakePeekUi() {
  const calls: Array<{
    factory: (tui: unknown, theme: PeekTheme, keybindings: PeekKeybindings, done: (r: "toggle" | undefined) => void) => unknown;
    options: { overlay?: boolean; overlayOptions?: Record<string, unknown> };
  }> = [];
  const gates: Array<(value: "toggle" | undefined) => void> = [];
  // Generic signature mirrors the host's ExtensionUIContext.custom so the
  // fake is structurally assignable to PeekManagerUi.
  const ui = {
    custom: <T,>(
      factory: (tui: unknown, theme: PeekTheme, keybindings: PeekKeybindings, done: (result: T) => void) => unknown,
      options?: unknown,
    ): Promise<T> => {
      calls.push({
        factory: factory as unknown as typeof calls[number]["factory"],
        options: options as typeof calls[number]["options"],
      });
      return new Promise<T>((resolve) => gates.push(resolve as (value: "toggle" | undefined) => void));
    },
    notify: (_m: string, _level?: "info" | "warning" | "error") => {},
    theme,
  };
  // Assignment cast: the fake's property-typed custom has the host's
  // contravariant factory params, so it needs the cast to PeekManagerUi
  // (a method-syntax signature elsewhere avoids it; this object literal
  // cannot). The tests only exercise the fake, never the real TUI types.
  return { ui: ui as unknown as PeekManagerUi, calls, gates };
}

function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("createPeekManager: open with no UI returns false and never calls custom", () => {
  const manager = createPeekManager({ getUi: () => undefined, now: () => 0, schedule: () => 0, cancel: () => {} });
  const job = runningJob();

  assert.equal(manager.open(job, () => job, () => undefined), false);
});

test("createPeekManager: open returns before custom resolves (fire-and-forget), floating first", () => {
  const { ui, calls, gates } = fakePeekUi();
  const manager = createPeekManager({ getUi: () => ui, now: () => 0, schedule: () => 0, cancel: () => {} });
  const job = runningJob();

  // The custom promise is still pending here — open() must already have
  // returned true, having only scheduled the overlay.
  assert.equal(manager.open(job, () => job, () => undefined), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.overlay, true);
  assert.equal(calls[0].options.overlayOptions!.width, "80%");
  assert.equal(gates.length, 1);
});

test("createPeekManager: done(\"toggle\") reopens in the other mode, cycling floating -> fullscreen -> floating", async () => {
  const { ui, calls, gates } = fakePeekUi();
  const manager = createPeekManager({ getUi: () => ui, now: () => 0, schedule: () => 0, cancel: () => {} });
  const job = runningJob();
  manager.open(job, () => job, () => undefined);

  // Mount the first window: the factory hands us done; route it to the gate.
  calls[0].factory({ requestRender: () => {} }, theme, keybindings, (r) => gates[0](r));
  gates[0]("toggle"); // the component's w key resolves the overlay with "toggle"
  await settleMicrotasks();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.overlayOptions!.width, "100%"); // fullscreen

  calls[1].factory({ requestRender: () => {} }, theme, keybindings, (r) => gates[1](r));
  gates[1]("toggle");
  await settleMicrotasks();

  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.overlayOptions!.width, "80%"); // back to floating
});

test("createPeekManager: a rejected custom promise takes the warn path", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (m: unknown) => warnings.push(String(m));
  try {
    const ui = {
      custom: () => Promise.reject(new Error("overlay exploded")),
      notify: (_m: string, _level?: "info" | "warning" | "error") => {},
      theme,
    };
    const manager = createPeekManager({ getUi: () => ui, now: () => 0, schedule: () => 0, cancel: () => {} });
    const job = runningJob();
    manager.open(job, () => job, () => undefined);

    await settleMicrotasks();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`^${WARN_PREFIX}`));
    assert.match(warnings[0], /overlay exploded/);
  } finally {
    console.warn = originalWarn;
  }
});

test("createPeekManager: close stops the live window's pulse idempotently, without resolving done", () => {
  const { ui, calls, gates } = fakePeekUi();
  const scheduler = fakeScheduler();
  const manager = createPeekManager({ getUi: () => ui, now: () => 0, schedule: scheduler.schedule, cancel: scheduler.cancel });
  const job = runningJob();
  manager.open(job, () => job, () => undefined);

  // Mounting via the factory starts the component's pulse on the manager's
  // own schedule/cancel pair — that is what close() has to stop.
  calls[0].factory({ requestRender: () => {} }, theme, keybindings, (r) => gates[0](r));
  assert.equal(scheduler.pendingCount(), 1);

  manager.close();
  manager.close(); // idempotent

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(gates.length, 1); // done() never fired
});

// --- createPeekManager scroll persistence ---

const componentShape = (component: unknown) =>
  component as { render(width: number): string[]; handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined };

test("createPeekManager: the scroll offset persists across a w-toggle reopen", async () => {
  const { ui, calls, gates } = fakePeekUi();
  const manager = createPeekManager({ getUi: () => ui, now: () => 0, schedule: () => 0, cancel: () => {} });
  const job = runningJob();
  manager.open(job, () => job, scrollTranscript);

  // Mount the first window and scroll it up two lines via the wheel.
  const first = componentShape(calls[0].factory({ requestRender: () => {} }, theme, keybindings, (r) => gates[0](r)));
  first.render(80); // fixes the scroll cap (30 - 24 = 6)
  assert.ok(first.handleMouse(wheelEvent(-2))); // handled, offset -> 2

  // Reopen in the other mode: the fresh component renders at the same offset.
  gates[0]("toggle");
  await settleMicrotasks();
  assert.equal(calls.length, 2);
  const second = componentShape(calls[1].factory({ requestRender: () => {} }, theme, keybindings, (r) => gates[1](r)));
  const reopened = second.render(80).join("\n");
  // At offset 2 the window sits four lines above the bottom (30 - 24 - 2),
  // so four hidden-above lines join the elision count.
  assert.match(reopened, /\u0028\+4 earlier\u0029/);
  assert.doesNotMatch(reopened, /line 30/); // the newest lines scrolled away

  // A real close clears the offset: the next open follows the tail again.
  gates[1](undefined);
  await settleMicrotasks();
  manager.open(job, () => job, scrollTranscript);
  assert.equal(calls.length, 3);
  const third = componentShape(calls[2].factory({ requestRender: () => {} }, theme, keybindings, (r) => gates[2](r)));
  const fresh = third.render(80).join("\n");
  assert.match(fresh, /line 30/); // follow mode again
  assert.match(fresh, /\u0028\+6 earlier\u0029/);
});

test("createPeekManager: close() resets the scroll offset for the next open too", async () => {
  const { ui, calls, gates } = fakePeekUi();
  const manager = createPeekManager({ getUi: () => ui, now: () => 0, schedule: () => 0, cancel: () => {} });
  const job = runningJob();
  manager.open(job, () => job, scrollTranscript);
  const first = componentShape(calls[0].factory({ requestRender: () => {} }, theme, keybindings, (r) => gates[0](r)));
  first.render(80);
  first.handleMouse(wheelEvent(-2));

  manager.close();
  manager.open(job, () => job, scrollTranscript);
  assert.equal(calls.length, 2);
  const second = componentShape(calls[1].factory({ requestRender: () => {} }, theme, keybindings, (r) => gates[1](r)));
  const frame = second.render(80).join("\n");
  assert.match(frame, /line 30/); // following again, not the scrolled affordance
  assert.doesNotMatch(frame, /\u0028\+2 earlier\u0029/); // the scrolled offset did not leak
});
