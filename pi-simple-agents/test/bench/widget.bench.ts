// Run: node --experimental-strip-types test/bench/widget.bench.ts
import { createJobWidget, type JobWidgetUi } from "../../src/job-widget.ts";
import type { JobSnapshot } from "../../src/background-jobs.ts";

const ITER = Number(process.env.BENCH_ITER ?? 200);
const EVENTS = 100;
const SPAN_MS = 5000;

const makeJob = (event: number): JobSnapshot => ({
  id: "S1",
  runId: "r1",
  startedAt: 0,
  task: { agent: "scout", task: "bench" },
  progress: { agent: "scout", runningTools: [], history: [], done: false, usage: { input: event, output: event, cacheRead: 0, cacheWrite: 0, cost: 0 } } as unknown as JobSnapshot["progress"],
  state: { status: "running" },
});

function run(): { calls: number; ms: number } {
  let t = 0;
  let calls = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const ui: JobWidgetUi = { setWidget: () => { calls++; }, theme: { fg: (_c, s) => s } };
  const widget = createJobWidget({
    getUi: () => ui,
    now: () => t,
    schedule: (fn, ms) => { const id = nextId++; pending.set(id, { at: t + ms, fn }); return id; },
    cancel: (h) => { pending.delete(h as number); },
  });
  const t0 = performance.now();
  const step = SPAN_MS / EVENTS;
  for (let i = 0; i < EVENTS; i++) {
    const target = i * step;
    for (;;) {
      const due = [...pending.entries()].filter(([, p]) => p.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = target;
    widget.refresh([makeJob(i)]);
  }
  const ms = performance.now() - t0;
  widget.dispose();
  return { calls, ms };
}

const samples: number[] = [];
let calls = 0;
for (let i = 0; i < ITER; i++) {
  const r = run();
  samples.push(r.ms);
  calls = r.calls;
}
const s = [...samples].sort((a, b) => a - b);
console.log(`widget bench — ${ITER} iterations, ${EVENTS} progress events in ${SPAN_MS} ms simulated`);
console.log(`setWidget calls: ${calls}`);
console.log(`simulation time  median ${s[Math.floor(s.length / 2)].toFixed(3)} ms   p95 ${s[Math.floor(s.length * 0.95)].toFixed(3)} ms`);
