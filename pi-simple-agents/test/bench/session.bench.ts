// Run: node --experimental-strip-types test/bench/session.bench.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelaunchCandidates, buildSubagentSessionReport, type ReconcileFs } from "../../src/session-reconcile.ts";

const ITER = Number(process.env.BENCH_ITER ?? 200);
const CHILDREN = 50;
const ROOT_BYTES = 5 * 1024 * 1024;

const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const usage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
const userMsg = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: text } });
const asstMsg = (id: string) => ({
  type: "message", id, parentId: null, timestamp: "2025-01-01T00:00:01Z",
  message: { role: "assistant", content: [{ type: "text", text: "done" }], usage, model: "m", provider: "p", stopReason: "stop" },
});

const dir = mkdtempSync(join(tmpdir(), "session-bench-"));
const rootFile = join(dir, "root.jsonl");
const childDir = (parentFile: string, runId: string) => join(parentFile.replace(/\.jsonl$/, ""), runId, "run-0");

// Root: filler messages up to ~5 MB, plus acks/results for the children (orphans: every 5th has no result).
const rootEntries: unknown[] = [userMsg("u0", "root task")];
for (let i = 0; i < CHILDREN; i++) {
  const runId = `run${String(i).padStart(3, "0")}`;
  rootEntries.push({
    type: "custom_message", customType: "subagent-ack", id: `ack${i}`, parentId: null, timestamp: "2025-01-01T00:00:00Z",
    details: { runId, jobId: `S${i}`, agent: "scout", task: `task ${i}` },
  });
  if (i % 5 !== 0) {
    rootEntries.push({
      type: "custom_message", customType: "subagent-result", id: `res${i}`, parentId: null, timestamp: "2025-01-01T00:00:02Z",
      content: "done", details: { runId, jobId: `S${i}`, agent: "scout", task: `task ${i}`, status: "completed", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.003 } },
    });
  }
}
const filler = "x".repeat(400);
let size = 0;
for (let i = 0; size < ROOT_BYTES; i++) {
  const e = i % 2 ? asstMsg(`a${i}`) : userMsg(`m${i}`, filler);
  size += JSON.stringify(e).length + 1;
  rootEntries.push(e);
}
mkdirSync(dir, { recursive: true });
writeFileSync(rootFile, jsonl(rootEntries));

// Two levels: each child has one grandchild.
for (let i = 0; i < CHILDREN; i++) {
  const runId = `run${String(i).padStart(3, "0")}`;
  const cdir = childDir(rootFile, runId);
  mkdirSync(cdir, { recursive: true });
  const childFile = join(cdir, "session.jsonl");
  writeFileSync(childFile, jsonl([userMsg("c0", `task ${i}`), asstMsg("c1")]));
  const gdir = childDir(childFile, `g${i}`);
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "session.jsonl"), jsonl([userMsg("g0", `sub ${i}`), asstMsg("g1")]));
}

const counts = { root: 0, grandchild: 0, child: 0, listDir: 0 };
const countingFs: ReconcileFs = {
  readTextFile(p) {
    if (p === rootFile) counts.root++;
    else if (p.includes("/session/")) counts.grandchild++;
    else counts.child++;
    try { return readFileSync(p, "utf8"); } catch { return undefined; }
  },
  listDir(p) {
    counts.listDir++;
    try { return readdirSync(p); } catch { return undefined; }
  },
};

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
}
const fmt = (n: number) => n.toFixed(3).padStart(10);
const rows: string[] = [];

function bench(name: string, fn: () => unknown) {
  for (let i = 0; i < 3; i++) fn();
  const samples: number[] = [];
  let last = { ...counts };
  for (let i = 0; i < ITER; i++) {
    counts.root = counts.grandchild = counts.child = counts.listDir = 0;
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
    last = { ...counts };
  }
  const { median, p95 } = stats(samples);
  rows.push(`${name.padEnd(36)} median ${fmt(median)} ms   p95 ${fmt(p95)} ms`);
  rows.push(`    reads/iter: root=${last.root} child=${last.child} grandchild=${last.grandchild} listDir=${last.listDir}`);
}

try {
  bench("buildRelaunchCandidates", () => buildRelaunchCandidates(rootFile, countingFs));
  bench("buildSubagentSessionReport", () => buildSubagentSessionReport(rootFile, countingFs));
  console.log(`session bench — ${ITER} iterations, root ${(size / 1048576).toFixed(1)} MB, ${CHILDREN} children x 2 levels`);
  console.log(rows.join("\n"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
