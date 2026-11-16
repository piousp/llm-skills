// Run: node --experimental-strip-types test/bench/peek.bench.ts
import { PeekOverlayComponent, type PeekTheme } from "../../src/peek-window.ts";
import { createTranscriptSink, MAX_TRANSCRIPT_CHARS, type TranscriptSink } from "../../src/transcript.ts";
import type { JobSnapshot } from "../../src/background-jobs.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const theme: PeekTheme = { fg: (c, t) => `<${c}>${t}</${c}>` };
const ITER = 200;
const WIDTH = 80;

const ev = (e: unknown) => e as AgentSessionEvent;
const word = (n: number, tag: string) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);
const textEnd = (content: string) => ev({ type: "message_update", assistantMessageEvent: { type: "text_end", content } });
const thinkingEnd = (content: string) => ev({ type: "message_update", assistantMessageEvent: { type: "thinking_end", content } });
const textDelta = (delta: string) => ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
const toolStart = (i: number) => ev({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read", args: { path: `f${i}` } });
const toolEnd = (i: number) => ev({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", result: "ok result", isError: false });

// ~2000 entries, ~50% text / 25% thinking / 25% tools, close to the char cap.
function fullSink(): TranscriptSink {
  const sink = createTranscriptSink();
  for (let i = 0; i < 500; i++) {
    sink.onSessionEvent(textEnd(word(90, `a${i}`)));
    sink.onSessionEvent(thinkingEnd(word(50, `th${i}`)));
    sink.onSessionEvent(textEnd(word(90, `b${i}`)));
    sink.onSessionEvent(i % 2 === 0 ? toolStart(i) : toolEnd(i));
  }
  sink.onSessionEvent(textDelta("live streaming text ".repeat(10)));
  return sink;
}

const job: JobSnapshot = {
  id: "S1",
  runId: "r1",
  startedAt: 0,
  task: { agent: "scout", task: "bench" },
  progress: { agent: "scout", runningTools: [], history: [], done: false },
  state: { status: "running" },
};

function makeComponent(sink: TranscriptSink, clock: { t: number }) {
  const pending: Array<() => void> = [];
  const counter = { renders: 0 };
  let comp: PeekOverlayComponent;
  const tui = { requestRender: () => { counter.renders++; comp.render(WIDTH); } };
  comp = new PeekOverlayComponent(tui, theme, { matches: () => false }, () => {}, {
    getJob: () => job,
    getTranscript: () => sink.snapshot(),
    now: () => clock.t,
    schedule: (fn) => { pending.push(fn); return pending.length; },
    cancel: () => {},
  });
  const fire = () => pending.pop()?.();
  return { comp, fire, counter };
}

function stats(samples: number[]): { median: number; p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
}

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const rows: string[] = [];
const fmt = (n: number) => n.toFixed(3).padStart(10);
function report(name: string, samples: number[], unit = "ms") {
  const { median, p95 } = stats(samples);
  rows.push(`${name.padEnd(46)} median ${fmt(median)} ${unit}   p95 ${fmt(p95)} ${unit}`);
}

// Warm-up (JIT) so the first-render case measures cold caches, not cold code.
{
  const w = makeComponent(fullSink(), { t: 1000 });
  for (let i = 0; i < 20; i++) w.comp.render(WIDTH);
  w.comp.dispose();
}

// (a) first render: fresh component each iteration
{
  const sink = fullSink();
  const samples: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const { comp } = makeComponent(sink, { t: 1000 });
    samples.push(time(() => comp.render(WIDTH)));
    comp.dispose();
  }
  report("(a) first render", samples);
}

// (b) hot render, same state
{
  const { comp } = makeComponent(fullSink(), { t: 1000 });
  comp.render(WIDTH);
  const samples: number[] = [];
  for (let i = 0; i < ITER; i++) samples.push(time(() => comp.render(WIDTH)));
  report("(b) hot render, same state", samples);
  comp.dispose();
}

// (c) render after appending one entry (the append itself is not timed)
{
  const sink = fullSink();
  const { comp } = makeComponent(sink, { t: 1000 });
  comp.render(WIDTH);
  const samples: number[] = [];
  for (let i = 0; i < ITER; i++) {
    sink.onSessionEvent(textEnd(word(90, `n${i}`)));
    samples.push(time(() => comp.render(WIDTH)));
  }
  report("(c) render after +1 entry", samples);
  comp.dispose();
}

// (d) width change on every render
{
  const { comp } = makeComponent(fullSink(), { t: 1000 });
  comp.render(WIDTH);
  const samples: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const w = i % 2 === 0 ? WIDTH + 20 : WIDTH;
    samples.push(time(() => comp.render(w)));
  }
  report("(d) width change", samples);
  comp.dispose();
}

// (e) 40 pulse ticks (10 s of 250 ms) with no transcript changes; the fake
// requestRender counts calls and renders like the TUI would.
let renderCalls = 0;
{
  const samples: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const clock = { t: 1000 };
    const { comp, fire, counter } = makeComponent(fullSink(), clock);
    comp.render(WIDTH);
    samples.push(time(() => {
      for (let k = 0; k < 40; k++) {
        clock.t += 250;
        fire();
      }
    }));
    renderCalls = counter.renders;
    comp.dispose();
  }
  report("(e) 40 ticks / 10 s, no changes (total)", samples);
  rows.push(`    requestRender calls in 40 ticks: ${renderCalls}`);
}

// pushEntry at the eviction ceiling: 10k tool-start events on a full ring.
{
  const perEvent: number[] = [];
  for (let run = 0; run < 20; run++) {
    const sink = fullSink();
    for (let i = 0; i < 100; i++) sink.onSessionEvent(toolStart(i)); // reach the cap
    const ms = time(() => {
      for (let i = 0; i < 10_000; i++) sink.onSessionEvent(toolStart(i));
    });
    perEvent.push((ms * 1000) / 10_000);
  }
  report("pushEntry at eviction cap (per event)", perEvent, "µs");
}

console.log(`peek bench — ${ITER} iterations, width ${WIDTH}, MAX_TRANSCRIPT_CHARS=${MAX_TRANSCRIPT_CHARS}`);
console.log(rows.join("\n"));
