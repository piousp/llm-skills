import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type OverlayOptions,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isActive, type JobSnapshot, type JobState } from "./background-jobs.ts";
import { buildFinishedTaskLine, formatElapsed, formatToolDuration } from "./job-view.ts";
import { firstLine } from "./text-utils.ts";
import type { TranscriptState } from "./transcript.ts";
import { formatRunUsage } from "./usage.ts";
import { toErrorMessage, WARN_PREFIX } from "./warn.ts";

/** Floating live window for `/subagents peek`: renders a job's transcript
 * (src/transcript.ts state) as a bounded tail of activity lines. Structure
 * mirrors src/job-widget.ts: pure render helper first, then the component and
 * the manager controller, all themed through structural subsets (no concrete
 * pi-tui theme classes in the exported types). */

/** Thinking is shown only as its last few display lines. */
const THINKING_TAIL_LINES = 5;
/** The body (everything between header and footer) is tail-sliced to this. */
const BODY_LINES = 24;
/** Live-window pulse: re-render cadence while the target job is active. */
const PULSE_MS = 250;

export interface PeekTheme {
  fg(color: "accent" | "dim" | "success" | "error" | "warning" | "muted", text: string): string;
}

export interface PeekKeybindings {
  matches(data: string, action: string): boolean;
}

/** Live render preferences the peek window follows: thinking visibility and
 * tool-result expansion. Both optional; absent/false keeps the default
 * behaviour (thinking shown as its ellipsis tail, tool results shown). Read
 * fresh on every render — never cached. */
export interface PeekRenderPrefs {
  hideThinking?: boolean;
  toolsExpanded?: boolean;
}

export interface PeekTui {
  requestRender(): void;
}

function statusColor(status: JobState["status"]): "accent" | "success" | "error" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "errored" || status === "cancelled") return "error";
  return "accent"; // running / cancelling
}

// Header: "<id> <agent> <status> · <elapsed>[ · <usage>]". Usage comes from
// the live progress snapshot, so a running job shows tokens spent so far.
function buildHeader(job: JobSnapshot, now: number, theme: PeekTheme): string {
  // Settled jobs freeze the elapsed clock at settle time (the same rule
  // buildJobListEntry applies in src/job-view.ts): re-opening one no longer
  // recomputes elapsed from `now`.
  const elapsedUntil = "settledAt" in job.state ? job.state.settledAt : now;
  const parts = [
    job.id,
    theme.fg("accent", job.task.agent),
    theme.fg(statusColor(job.state.status), job.state.status),
    `\u00b7 ${formatElapsed(elapsedUntil - job.startedAt)}`,
  ];
  if (job.progress.usage) parts.push(`\u00b7 ${theme.fg("dim", formatRunUsage(job.progress.usage))}`);
  return parts.join(" ");
}

// Footer: one short dim line. The `w` hint names the mode the key switches
// TO; the scroll hint joins only once the body outgrows the window (the
// frame's width guard truncates the line if it ever got too long).
function buildFooter(theme: PeekTheme, fullscreen: boolean, scrollable = false): string {
  const base = fullscreen ? " Esc/q close \u00b7 w window" : " Esc/q close \u00b7 w fullscreen";
  return theme.fg("dim", scrollable ? `${base} \u00b7 \u2191/\u2193 scroll` : base);
}

// Wraps one display line to the viewport width. Returns [] for empty content
// (wrapTextWithAnsi("") is [""], a blank line nothing needs).
function wrapLines(text: string, width: number): string[] {
  if (!text) return [];
  return wrapTextWithAnsi(text, width);
}

// The thinking cap: across every thinking entry plus the live currentThinking
// run, only the last THINKING_TAIL_LINES display lines survive; the first
// visible one carries the dim ellipsis marker. Segments outside the window
// render nothing, so interleaved thinking keeps its position in the flow.
function thinkingKeptLines(segments: string[][], width: number, theme: PeekTheme): string[][] {
  const wrapped = segments.map((s) => wrapLines(s.join("\n"), width));
  const total = wrapped.reduce((n, w) => n + w.length, 0);
  const skip = Math.max(0, total - THINKING_TAIL_LINES);
  let seen = 0;
  let marked = false;
  return wrapped.map((lines) => {
    const start = seen;
    seen += lines.length;
    const from = Math.max(start, skip);
    if (from >= seen) return [];
    const kept = lines.slice(from - start);
    if (marked) return kept.map((l) => theme.fg("dim", l));
    marked = true;
    return [theme.fg("dim", `\u2026 ${kept[0].trim()}`), ...kept.slice(1).map((l) => theme.fg("dim", l))];
  });
}

// Builds the FULL body line list (no tail slice, no elision line): entries
// in order, live streaming tails after them (only while the state is live),
// plus how many entries the transcript's ring buffer already dropped.
// Prefs gates: hideThinking drops thinking entries and the live thinking run
// entirely; toolsExpanded === false drops tool-end result lines (the
// single-line tool-start ▸ entries stay). The settled final result line is
// appended AFTER the scroll slice (see buildPeekLines) so it never scrolls
// off.
function buildFullBody(
  job: JobSnapshot,
  transcript: TranscriptState | undefined,
  theme: PeekTheme,
  width: number,
  prefs: PeekRenderPrefs | undefined,
): { body: string[]; dropped: number } {
  const settled = !isActive(job.state);
  const hideThinking = prefs?.hideThinking === true;
  const collapseTools = prefs?.toolsExpanded === false;
  const hasContent = transcript !== undefined &&
    (transcript.entries.length > 0 || transcript.currentText !== "" || transcript.currentThinking !== "");

  if (!hasContent) {
    // Never blank: the task's first line stands in until anything streams.
    return { body: [theme.fg("dim", firstLine(job.task.task))], dropped: transcript?.dropped ?? 0 };
  }

  // Blocks keep the render order: plain line groups and thinking slots,
  // whose lines are only known after the global thinking cap is computed.
  const blocks: Array<{ kind: "lines"; lines: string[] } | { kind: "thinking"; index: number }> = [];
  const thinkingSegments: string[][] = [];
  for (const e of transcript.entries) {
    if (e.kind === "thinking") {
      if (!hideThinking) {
        blocks.push({ kind: "thinking", index: thinkingSegments.length });
        thinkingSegments.push([e.content]);
      }
    } else if (e.kind === "text") {
      blocks.push({ kind: "lines", lines: wrapLines(e.content, width) });
    } else if (e.kind === "tool-start") {
      blocks.push({ kind: "lines", lines: [`\u25b8 ${e.label}`] });
    } else if (!collapseTools) {
      // Per-tool duration (pi >= 1.1.0): appended only when the entry
      // carries it — hosts without the field render the same line as
      // before. Nested tool calls make their own entries, each with its
      // own durationMs, so no line can carry a misattributed duration.
      const duration = e.durationMs !== undefined ? ` \u00b7 ${formatToolDuration(e.durationMs)}` : "";
      blocks.push({
        kind: "lines",
        lines: [e.ok ? theme.fg("dim", `\u25aa ${e.summary}${duration}`) : theme.fg("error", `\u25aa ${e.summary}${duration}`)],
      });
    }
  }

  // Live streaming tails ("en vivo") — only while the job is still going.
  if (!settled) {
    if (transcript.currentThinking !== "" && !hideThinking) {
      blocks.push({ kind: "thinking", index: thinkingSegments.length });
      thinkingSegments.push([transcript.currentThinking]);
    }
    if (transcript.currentText !== "") blocks.push({ kind: "lines", lines: wrapLines(transcript.currentText, width) });
  }

  const kept = thinkingKeptLines(thinkingSegments, width, theme);
  const body: string[] = [];
  for (const block of blocks) {
    body.push(...(block.kind === "lines" ? block.lines : kept[block.index]));
  }

  return { body, dropped: transcript.dropped };
}

/** Draws the complete peek window frame: 1-cell box borders with a title
 * set into the top border, one cell of horizontal padding so content never
 * touches the side borders, and per-line pad/truncate at the inner width.
 * `truncateToWidth`'s pad option measures visible width, so themed lines pad
 * correctly despite their escape sequences. */
function withFrame(contentLines: readonly string[], title: string, theme: PeekTheme, width: number): string[] {
  const outer = Math.max(4, width); // corners + at least one interior cell
  const inner = outer - 4; // border + 1 padding cell per side
  const titleSlot = Math.max(0, outer - 6); // corners, border dashes, spaces
  const bordered = theme.fg("accent", truncateToWidth(title, titleSlot));
  // Dashes fill from the STYLED title's visible width: ANSI (real renderer) is
  // zero-width while the test theme's tags are visible — both must fit.
  const topDashes = Math.max(0, outer - 6 - visibleWidth(bordered));
  const frame: string[] = [
    `\u250c\u2500 ${bordered} ${"\u2500".repeat(topDashes)}\u2510`,
    ...contentLines.map((line) => `\u2502 ${truncateToWidth(line, inner, "\u2026", true)} \u2502`),
    `\u2514${"\u2500".repeat(outer - 2)}\u2518`,
  ];
  return frame.map((line) => truncateToWidth(line, outer));
}

// Pure line builder for one peek frame: title row, header, body, footer inside
// a 1-cell box border frame with horizontal padding.
// `prefs` optionally gates thinking/tool-result rendering; `scroll`, when
// present, slices the body `offset` lines up from its bottom (0 = follow the
// live tail, byte-identical to the no-scroll path).
export function buildPeekLines(
  job: JobSnapshot,
  transcript: TranscriptState | undefined,
  now: number,
  theme: PeekTheme,
  width: number,
  fullscreen: boolean,
  prefs?: PeekRenderPrefs,
  scroll?: { offset: number },
): string[] {
  const inner = Math.max(1, Math.max(4, width) - 4);
  const { body: fullBody, dropped } = buildFullBody(job, transcript, theme, inner, prefs);
  const cap = Math.max(0, fullBody.length - BODY_LINES);

  // Scrolled mode slices the full body `offset` lines up from the bottom;
  // follow mode keeps the plain tail slice — the two coincide at offset 0.
  // Either way the shown window is at most BODY_LINES lines, and everything
  // above it joins the transcript's own dropped entries in the elision count.
  let elided = dropped;
  let body: string[];
  if (scroll) {
    const offset = Math.max(0, scroll.offset);
    const start = Math.max(0, fullBody.length - BODY_LINES - offset);
    elided += start;
    body = fullBody.slice(start, Math.max(0, fullBody.length - offset));
  } else if (fullBody.length > BODY_LINES) {
    elided += fullBody.length - BODY_LINES;
    body = fullBody.slice(-BODY_LINES);
  } else {
    body = fullBody;
  }
  if (elided > 0) body.unshift(theme.fg("dim", `\u2026 (+${elided} earlier)`));

  // Settled jobs append their final outcome right after the body — outside
  // the scroll window, so it stays visible while scrolled. Narrowing via
  // "settledAt" in state: TS cannot narrow job.state through a boolean.
  if ("settledAt" in job.state) {
    const state = job.state;
    body.push(state.status === "errored" ? `  ${state.error}` : buildFinishedTaskLine(state.result, theme));
  }

  const content = [
    buildHeader(job, now, theme),
    ...body,
    buildFooter(theme, fullscreen, cap > 0),
  ];
  return withFrame(content, `peek \u00b7 ${job.id} \u00b7 ${job.task.agent}`, theme, width);
}

/** How far the peek body can scroll up: full-body lines past the visible
 * BODY_LINES window (0 when everything already fits). The component asks for
 * this once per render to keep its scroll offset clamped. */
export function peekScrollCap(
  job: JobSnapshot,
  transcript: TranscriptState | undefined,
  theme: PeekTheme,
  width: number,
  prefs?: PeekRenderPrefs,
): number {
  return Math.max(0, buildFullBody(job, transcript, theme, width, prefs).body.length - BODY_LINES);
}

/** Result delivered to the manager through ctx.ui.custom's `done`:
 * `undefined` closes the window, `"toggle"` reopens it in the other mode. */
export type PeekDone = (result: "toggle" | undefined) => void;

/** What the host hands a PeekOverlayComponent: live accessors for the job
 * snapshot and transcript, the injected scheduler for the pulse timer, and
 * the view mode this overlay instance was opened in. The render prefs, the
 * initial scroll offset, and the scroll callback exist because the MANAGER
 * (not this component) owns preference wiring and `w`-toggle persistence. */
export interface PeekOverlayDeps {
  getJob: () => JobSnapshot | undefined;
  getTranscript: () => TranscriptState | undefined;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  fullscreen: boolean;
  /** Live render prefs — read fresh on every render, never cached. */
  getPrefs?: () => PeekRenderPrefs | undefined;
  /** Initial scroll offset: full-body lines up from the bottom (0 follows). */
  scrollOffset?: number;
  /** Notified after every keyboard/wheel scroll with the new offset. */
  onScroll?: (offset: number) => void;
  /** Notified on the app.tools.expand key: the manager routes it to the
   * main view's tool-expansion toggle (optional like onScroll, so test
   * fakes keep compiling without it). */
  onToggleTools?: () => void;
}

/** One overlay instance per open (one-interaction-per-instance rule): it owns
 * the pulse timer and resolves `done` exactly once from its own input
 * handling. `dispose()` only stops the timer — the shutdown path may call it
 * without the window ever having been closed by the user. */
export class PeekOverlayComponent {
  private timer: unknown;
  // Fields + explicit assignments (no parameter properties): node's
  // strip-only TypeScript mode rejects constructor parameter properties.
  private tui: PeekTui;
  private theme: PeekTheme;
  private keybindings: PeekKeybindings;
  private done: PeekDone;
  private deps: PeekOverlayDeps;
  private scrollOffset: number;
  // Scroll capacity, re-derived on every render (the full body grows and
  // shrinks); until the first render arrives there is nothing to scroll.
  private scrollCap = 0;

  constructor(
    tui: PeekTui,
    theme: PeekTheme,
    keybindings: PeekKeybindings,
    done: PeekDone,
    deps: PeekOverlayDeps,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.deps = deps;
    this.scrollOffset = deps.scrollOffset ?? 0;
    this.timer = this.deps.schedule(() => this.tick(), PULSE_MS);
  }

  // Pulse tick: re-render while the target job is active; on the first
  // observation of a settled (or pruned) job, render once more — freezing the
  // frame to the final result — and stop rescheduling.
  private tick(): void {
    this.timer = undefined; // this invocation consumed the scheduled handle
    const job = this.deps.getJob();
    if (job && isActive(job.state)) {
      this.tui.requestRender();
      this.timer = this.deps.schedule(() => this.tick(), PULSE_MS);
    } else {
      this.tui.requestRender();
    }
  }

  private stopPulse(): void {
    if (this.timer !== undefined) {
      this.deps.cancel(this.timer);
      this.timer = undefined;
    }
  }

  render(width: number): string[] {
    const job = this.deps.getJob();
    if (!job) {
      // The registry pruned the job (maxRecent): a minimal dim frame.
      return withFrame(
        [this.theme.fg("dim", "job finished and evicted"), buildFooter(this.theme, this.deps.fullscreen)],
        "peek",
        this.theme,
        width,
      );
    }
    // Prefs are read live on every render (never cached); the scroll offset
    // is clamped against the (text-dependent) cap before it reaches the
    // body slice. The cap is measured at the body's own wrap width (the
    // frame's inner width), the same one buildPeekLines wraps the body at.
    const prefs = this.deps.getPrefs?.();
    const transcript = this.deps.getTranscript();
    const inner = Math.max(1, Math.max(4, width) - 4);
    this.scrollCap = peekScrollCap(job, transcript, this.theme, inner, prefs);
    const offset = this.clampScroll(this.scrollOffset, this.scrollCap);
    return buildPeekLines(job, transcript, this.deps.now(), this.theme, width, this.deps.fullscreen, prefs, { offset });
  }

  // Scroll offset, counted in full-body lines up from the bottom (0 = follow
  // the live tail). Reaching the bottom — offset 0 — re-engages the follow.
  private clampScroll(offset: number, cap: number): number {
    return Math.max(0, Math.min(offset, cap));
  }

  // Shared step for keyboard and mouse-wheel scrolling: applies the delta,
  // clamps, and reports the new offset (also at a boundary, where it is an
  // idempotent no-op). The cap comes from the last render — overlays always
  // render before input reaches the component.
  private stepScroll(delta: number): void {
    this.scrollOffset = this.clampScroll(this.scrollOffset + delta, this.scrollCap);
    this.deps.onScroll?.(this.scrollOffset);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
      this.stopPulse();
      this.done(undefined);
      return;
    }
    if (data === "w") {
      this.stopPulse();
      this.done("toggle");
      return;
    }
    // Tool-output expansion (Ctrl+O by default), resolved through the
    // injected keybindings so user rebindings are respected. Delegated to
    // the manager, which routes it to the main view's toggle: the window
    // stays open (no stopPulse, no done, no scrollOffset move).
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.deps.onToggleTools?.();
      return;
    }
    // Scrolling, resolved through the injected keybindings: Up/PageUp move
    // toward the past (the offset grows), Down/PageDn back toward the
    // bottom. Pages are half the body's visible capacity.
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.stepScroll(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.stepScroll(-1);
      return;
    }
    const page = Math.floor(BODY_LINES / 2);
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.stepScroll(page);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.stepScroll(-page);
      return;
    }
    // Any other input is ignored. That includes Ctrl+T (thinking
    // visibility): the host keybinding matches, but there is no
    // extension-visible setter for hideThinkingBlock (pi.getSettings()
    // returns a copy; SettingsManager.setHideThinkingBlock is internal),
    // so it is not supported while the peek window is open — close it
    // (Esc/q) and press Ctrl+T in the main UI.
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Wheel only. wheelDelta is negative scrolling up (toward the past), so
    // the offset from the bottom grows by -wheelDelta; returning
    // handled:true keeps the renderer's own wheel fallback (e.g. the
    // fullscreen "jump to latest message") out of the way while the pointer
    // is over the window. Any other mouse event passes through untouched.
    if (event.type !== "wheel") return undefined;
    this.scrollOffset = this.clampScroll(this.scrollOffset - (event.wheelDelta ?? 0), this.scrollCap);
    this.deps.onScroll?.(this.scrollOffset);
    return { handled: true };
  }

  // All themed output is computed per render; nothing to invalidate.
  invalidate(): void {}

  dispose(): void {
    this.stopPulse();
  }
}

/** Structural subset of the host UI context the manager needs. */
export interface PeekManagerUi {
  custom: ExtensionUIContext["custom"];
  notify(message: string, level?: "info" | "warning" | "error"): void;
  theme: PeekTheme;
  /** Tool-output expansion state of the MAIN view: the peek window's
   * Ctrl+O routes here (ExtensionUIContext supplies both; the real
   * getUi() in extensions/index.ts satisfies it as-is). */
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

export interface PeekManagerDeps {
  /** Returns undefined in non-interactive modes (no UI to open a window in). */
  getUi: () => PeekManagerUi | undefined;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** Live peek render prefs (thinking visibility / tool expansion); each
   * window reads them through its component on every render. */
  getRenderPrefs?: () => PeekRenderPrefs;
}

export interface PeekManager {
  /** Opens the peek window for `job`. Returns false (no-op) without a UI. */
  open(
    job: JobSnapshot,
    getJob: () => JobSnapshot | undefined,
    getTranscript: () => TranscriptState | undefined,
  ): boolean;
  /** Idempotent timer stop for session shutdown — never resolves done(). */
  close(): void;
}

const FLOATING_OVERLAY: OverlayOptions = { width: "80%", maxHeight: "50%", anchor: "center" };
const FULLSCREEN_OVERLAY: OverlayOptions = { width: "100%", maxHeight: "100%", margin: 0 };

// Drives the peek overlay: `open` fires ctx.ui.custom without awaiting it
// (McpManager precedent — the overlay lives until the component's done()
// fires), a "toggle" resolution reopens in the other mode, and a rejection
// degrades to a console warning. The latest component is tracked so
// `close()` can stop its pulse on shutdown.
export function createPeekManager(deps: PeekManagerDeps): PeekManager {
  let current: PeekOverlayComponent | undefined;
  // Scroll offset of the currently open window, owned here because a `w`
  // toggle recreates the component instance: the new one reopens at the same
  // offset, and a real close resets it so the next open auto-follows.
  let lastScrollOffset = 0;

  function openWith(
    ui: PeekManagerUi,
    mode: "floating" | "fullscreen",
    job: JobSnapshot,
    getJob: () => JobSnapshot | undefined,
    getTranscript: () => TranscriptState | undefined,
  ): void {
    const overlayOptions = mode === "floating" ? FLOATING_OVERLAY : FULLSCREEN_OVERLAY;
    void ui.custom<"toggle" | undefined>((tui, theme, keybindings, done) => {
      current = new PeekOverlayComponent(tui, theme, keybindings, done, {
        getJob,
        getTranscript,
        now: deps.now,
        schedule: deps.schedule,
        cancel: deps.cancel,
        fullscreen: mode === "fullscreen",
        getPrefs: () => deps.getRenderPrefs?.(),
        scrollOffset: lastScrollOffset,
        onScroll: (offset) => {
          lastScrollOffset = offset;
        },
        // Parity with the host's own Ctrl+O: flipping the main view's
        // toggle triggers the host re-render, and the window reads the
        // prefs fresh on its next frame — no local state to keep.
        onToggleTools: () => ui.setToolsExpanded(!ui.getToolsExpanded()),
      });
      return current;
    }, { overlay: true, overlayOptions }).then((result) => {
      current = undefined;
      if (result === "toggle") {
        // Reopen keeps the scroll position (lastScrollOffset untouched).
        openWith(ui, mode === "floating" ? "fullscreen" : "floating", job, getJob, getTranscript);
      } else {
        lastScrollOffset = 0; // real close: the next open follows the tail
      }
    }).catch((error: unknown) => {
      current = undefined;
      console.warn(`${WARN_PREFIX}peek window failed: ${toErrorMessage(error)}`);
    });
  }

  return {
    open(job, getJob, getTranscript) {
      const ui = deps.getUi();
      if (!ui) return false;
      openWith(ui, "floating", job, getJob, getTranscript); // decision C: floating first
      return true;
    },
    close() {
      current?.dispose();
      current = undefined;
      lastScrollOffset = 0;
    },
  };
}
