---
name: agent-prompting
description: >
  Use when preparing to send a prompt to a pi subagent: web-search
  delegation (web-scout), codebase recon (scout), planning (planner),
  implementation (worker, code-implementer), review or analysis (analyst
  with a lens), or the transparency step of showing the user the exact
  prompt before delegating. Triggers on writing, assembling, or sharpening
  a subagent prompt; delegating a search, plan, implementation, review, or
  analysis. Guides hub-and-spoke delegation: flow map, prompt anatomy,
  per-type templates (web-search, planner, implementation, review,
  meta-coordination), delegate-vs-do criteria, fail-closed lens rules,
  skills: []. [DO NOT] use for general chat, prose writing, or tasks the
  coordinator does directly without a subagent.
---

# Agent Prompting

Auto-triggered. [NEVER] invoked by name. This skill guides how to write
delegation prompts; it does not orchestrate agents, pick the cast, or run
the flow. The coordinator decides; this skill shapes the message.

## 1. Purpose and triggering

Loads when the coordinator is about to write, assemble, or sharpen a prompt
for a pi subagent: web search, codebase recon, planning, implementation,
review, analysis, or the transparency step with the user.

Scope is prompt writing only. This skill standardizes the message the
coordinator sends. Choosing the agent, the lens, and the timing stays with
the coordinator.

## 2. Hub-and-spoke flow map

The flow this skill serves, as it runs today:

```
goal-discovery: coordinator writes goal.md and decisions.md (carve-outs, [NEVER] delegate)
   |
   +- fact lookup --------> A: scout (code) | web-scout (web)          [T-scout / T1]
   +- plan ---------------> B: planner + lens (pablo-code-planning | pablo-tdd)   [T2]
   +- implement ----------> C: worker + lens | TDD direct               [T3]
   +- review -------------> D: analyst + lens (code-review-checklist |
   |                          qa-adversary | refactor-identification)              [T4]
   +- meta ---------------> E: coordinator -> user (preview + digest)               [T5]
```

| Point | Type | Agent | Lens | Contract | Template |
|---|---|---|---|---|---|
| A | Fact lookup | scout / web-scout | none; inline contract for web | findings, no interpretation | T-scout / T1 |
| B | Plan | planner (read-only) | pablo-code-planning or pablo-tdd | one plan, verification per step | T2 |
| C | Implementation | worker / TDD | pablo-code-philosophy or pablo-tdd | lens output or Execution Summary | T3 |
| D | Review | analyst (read-only) | code-review-checklist, qa-adversary, refactor-identification | lens template verbatim | T4 |
| E | Transparency | coordinator -> user | none | preview, digest, deferrals | T5 |

Carve-outs:

- goal.md and decisions.md are written by the coordinator only; [NEVER] delegate their writing.
- Tree views and session close belong to pablo-toolkit; T5 covers preview, digest, and deferrals only.
- Fact lookups always go to a scout or web-scout; [NEVER] run them inline in the coordinator.

## 3. Prompt anatomy

Every delegation prompt carries five blocks. Missing one produces a known failure mode.

| Block | Question it answers | Failure mode if missing |
|---|---|---|
| ROLE / CONTEXT | Who the agent is, what context matters | Duplication, re-discovery |
| OBJECTIVE | One deliverable, one task, no micro-steps | Vague delegation, premature done |
| OUTPUT CONTRACT | Exact format, fields, verdict; JSON when parsed | Broken parser, buried findings |
| LIMITS | In/out scope, tools, budget, stop rule | Excessive one-shot, scope creep |
| FAIL-CLOSED | What to do if the lens cannot be read; skills: [] | Default review, invented output |

## 4. Thirteen principles

| # | Principle | Verification |
|---|---|---|
| P1 | State an explicit output contract; use JSON when the output is parsed | empirical |
| P2 | Pass trimmed context in, demand condensed results out | empirical |
| P3 | Set in/out limits per subagent | empirical |
| P4 | Write invariants with the reason attached | empirical |
| P5 | Fail closed on lenses and set skills: [] | empirical (local ecosystem) |
| P6 | Give an explicit stop rule: N sources or M queries, first wins | reputational + empirical |
| P7 | Reformulate web queries; measured recall 0.52 to 0.81 | empirical |
| P8 | Triangulate 3+ independent sources | reputational |
| P9 | Verify claims against the original source | reputational (CitationAgent) |
| P10 | State the objective directly; no instructive chain-of-thought | reputational (OpenAI, Raschka) |
| P11 | Require executable, independent verification | empirical |
| P12 | Demand actionable output: severity, file:line, "what I could not verify" | reputational |
| P13 | Price the fan-out: agents ~4x tokens, multi-agent ~15x | empirical |

## 5. Delegate or do it yourself

Measured costs: a single agent spends about 4x the tokens of direct chat; a
multi-agent system about 15x. Fan-out pays only when the task parallelizes,
exceeds one context window, or touches many complex tools. Code parallelizes
less than research.

Delegate when:

- The work parallelizes into independent units.
- The needed context exceeds what the coordinator can hold.
- The step needs independent read-only judgment: planning, review, audit.
- The task falls in a delegation carve-out: fact lookups, plans,
  implementation, and reviews never run inline in the coordinator.

Do directly when:

- The answer is already in the coordinator's context.
- The chain is short and sequential.
- The artifact is coordinator-owned: goal.md, decisions.md, the prompt itself.

Scale effort to complexity: trivial work goes direct; simple work uses one
agent; complex work runs planner first, then worker; broad research fans out
to parallel web-scouts with a stop rule. Fail early: a delegation that fails
twice at the same point needs a different mechanism, not different wording.
Full math and scales: references/cost.md.

## 6. Delegation templates

Each template is a complete prompt to send: fill the placeholders, keep the
structure. The templates live in the reference files, next to the evidence
and the worked examples. Read the reference for the delegation you are
about to send, then assemble the prompt with the template inside it.

| Delegation | Read | Template |
|---|---|---|
| Web search (web-scout) | references/web-search.md | T1 |
| Codebase fact lookup (scout) | references/agents.md | T-scout |
| Planning (planner) | references/planner.md | T2 |
| Implementation (worker or TDD) | references/implementation.md | T3 |
| Review or analysis (analyst with a lens) | references/review.md | T4 |
| Transparency (coordinator -> user) | references/meta-coordination.md | T5 |
| Whether to delegate at all | references/cost.md | gate |

Each reference opens with its "Use when / Do NOT use when" and carries the
lessons, the evidence, and a worked example. The web-search reference is
the only one with an inline-contract requirement: web-only agents cannot
read local lens files, so its template must be pasted into the prompt
verbatim ([NEVER] pass it as a lens path).
