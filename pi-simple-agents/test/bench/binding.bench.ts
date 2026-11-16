// Run: node --experimental-strip-types test/bench/binding.bench.ts
import { missingRequestedTools, type ToolSource } from "../../src/extension-binding.ts";

const ITER = Number(process.env.BENCH_ITER ?? 200);
const INNER = 200;

const tools: ToolSource[] = Array.from({ length: 200 }, (_, i) => ({
  name: i % 4 === 0 ? `mcp__server${i % 7}__tool${i}` : `tool_${i}`,
  sourceInfo: { path: `builtin:tool_${i}`, origin: "top-level", source: "builtin" },
}));
const requested = ["mcp__server1__*", "mcp__server*__tool8", "tool_1*", "nomatch_*", "*__tool196"];

const expected = missingRequestedTools(tools, requested);
const samples: number[] = [];
for (let i = 0; i < 20; i++) missingRequestedTools(tools, requested);
for (let i = 0; i < ITER; i++) {
  const t0 = performance.now();
  for (let k = 0; k < INNER; k++) missingRequestedTools(tools, requested);
  samples.push(((performance.now() - t0) * 1000) / INNER);
}
const s = [...samples].sort((a, b) => a - b);
console.log(`binding bench — ${ITER} iterations x ${INNER} calls, ${tools.length} tools, ${requested.length} wildcard patterns`);
console.log(`missingRequestedTools  median ${s[Math.floor(s.length / 2)].toFixed(3)} µs/call   p95 ${s[Math.floor(s.length * 0.95)].toFixed(3)} µs/call`);
console.log(`result (sanity): ${JSON.stringify(expected)}`);
