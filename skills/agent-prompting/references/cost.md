# Cost of Delegation (section 5)

Reference file for section 5 of SKILL.md. Read this when deciding
whether to delegate at all, and at what scale.

## The 4x/15x math

Measured costs:

- One agent doing a task costs about 4x the tokens of doing it in
  direct chat.
- A multi-agent run costs about 15x.

Where the multipliers come from:

- The prompt repeats the role, the goal, and the context for every
  agent.
- Each agent re-reads files or sources the coordinator already holds.
- Each agent produces a full output, not a delta.
- The coordinator digests, relays, and reconciles every result.

Why 4x for one agent: the coordinator context (1x) plus the agent's full
read of the prompt, its exploration, its output, and the digest. Why 15x
for many agents: every extra hop multiplies the relay cost, and
intermediate results are read by more than one agent.

Worked math: a 10k-token task done directly costs about 10k tokens. The
same task through one agent costs about 40k. A full run with a planner,
two workers, and a reviewer costs about 150k.

## When the multiplier pays

Delegate when:

- The work parallelizes into independent units. Fan-out divides wall
  time: tokens go up, latency goes down.
- The needed context exceeds what the coordinator can hold. One context
  window cannot fit the sources; agents split the reading.
- The step needs independent read-only judgment: planning, review,
  audit.
- The task falls in a delegation carve-out: fact lookups, plans,
  implementation, and reviews never run inline in the coordinator.

Do directly when:

- The answer is already in the coordinator context. Delegation only
  re-reads what is already read.
- The chain is short and sequential. Each step depends on the previous;
  there is no parallelization, only relay cost.
- The artifact is coordinator-owned: goal.md, decisions.md, the prompt
  itself.

## Effort scales

| Complexity | Shape | Mechanism |
|---|---|---|
| Trivial | A fact or answer already in context | Direct; no agent |
| Simple | One well-bounded step | One agent (scout, web-scout, or worker) |
| Complex | Sequencing, seams, test plan | Planner first, then worker |
| Broad research | Wide topic, many sources | Fan-out to parallel web-scouts with a stop rule |

Scale effort to complexity. Delegating a trivial step costs 4x for no
gain. Running a planner for a simple step burns the 15x multiplier on a
task one agent finishes.

## Fail early

A delegation that fails twice at the same point needs a different
mechanism, not different wording.

- First failure: find the missing prompt block (anatomy in SKILL.md
  section 3), fix it, resend once.
- Second failure at the same point: stop. Change the mechanism: a
  different agent, a split task, or the work pulled back into the
  coordinator.
- [NEVER] keep resending the same prompt with cosmetic changes; that is
  the most expensive form of the 15x multiplier.

## Decision checklist

- Does the task parallelize? If no, and the answer is in context, do it
  directly.
- Does the context fit one window? If yes and the chain is short, do it
  directly.
- Is independent read-only judgment needed? Delegate to planner or
  analyst.
- Is the artifact coordinator-owned? Keep it in the coordinator.
- When delegating: pick the scale (one agent, planner then worker, or
  fan-out), set the stop rule, and fail early.
