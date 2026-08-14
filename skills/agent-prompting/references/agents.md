# Agent roster: verified capabilities

Verified against the frontmatter files in /home/pablo/.pi/agent/agents/.
Last verified: 2026-08-14. The roster reflects the files as they exist
today; when in doubt, re-read the frontmatter. Effective values can differ
when settings.json declares agent overrides; the notes below mark the ones
that exist.

## Roster

| Agent | tools | maxTurns | systemPromptMode | project context | Invariants (abridged) |
|---|---|---|---|---|---|
| web-scout | web_search, web_read, read | 20 | replace | none | no fabricated sources; 10-call abort ceiling; one read attempt per URL, one retry with another reader, then drop; no-results JSON on ceiling |
| planner | read, grep, find, ls, bash, subagent | none | replace | none | read-only; no implementation; no scope expansion; no unnecessary subagents; stop if the objective is missing |
| worker | read, write, edit, bash, grep, find, ls | none | replace | none | one task per invocation; stop on failure; disclose every filesystem change; clean tree; lens fail-closed |
| analyst | read, bash, grep, find, ls, subagent | none | append | none | no write or edit; bash for read-only queries only; evidence-based findings; lens fail-closed |
| scout | read, grep, find, ls | none | append | none | no bash; no subagents; no interpretation or evaluation; never invent a finding; "No results found" valid |
| code-implementer | read, grep, find, ls, write, edit (disallowed: bash, subagent) | none | replace | inherited | no lens = no changes; no execution, never claims test results; never touches git; never deletes or weakens existing tests; handoff summary |
| redactor | read, grep, find, ls, write, edit | none | (none) | (none) | no execution; never writes under .design/; draft frozen stays frozen; surgical edits only |
| revisor-evaluador | read, write, edit | none | (none) | (none) | no shell, no subagents, no extra tool calls after finishing; no unsolicited changes; JSON findings |

## Per-agent notes

### web-scout

- Abort ceiling: 10 tool calls total, across search and read. On reaching
  it, stop and return the no-results JSON, even mid-task, even if a lens's
  own budget has not run out.
- Default mode: run 2 web_search queries with different angles, pick the
  best URL, read it once with web_read. Default limits: maximum 2
  web_search and 1 web_read; a named lens sets its own budget, still bounded
  by the 10-call ceiling.
- read is now in tools: the agent can read a local lens file by path when
  the invocation names one. A lens may override the process and output
  contract but never the absolute invariants (no fabricated sources, 10-call
  ceiling).
- The no-results JSON has fixed fields: result, queries_tried,
  urls_attempted, ceiling_hit, note.
- settings.json override: thinking off.

### planner

- Read-only: no writes, no edits, no implementation. May delegate recon to
  scout or web-scout via subagent.
- Frontmatter: timeoutMs 900000 (15 minutes), thinking high. settings.json
  overrides thinking to xhigh and pins skills to pablo-code-planning and
  pablo-tdd.
- External lens mode: a Lens line replaces the internal lens selection; if
  the lens cannot be read, stop and report, do not fall back to the internal
  heuristics.
- Output: PLAN and TECHNICAL, or the lens contract verbatim.

### worker

- inheritProjectContext: false: no project context is inherited; everything
  the worker needs must be in the prompt. This is why T3 pastes the plan
  slice verbatim and names the files in scope.
- Full executor toolset, including write, edit, and bash.
- Lens mode: a Lens line replaces the default Execution Summary format;
  fail-closed if the lens is unreadable. A lens never widens tools or scope.
- settings.json override: thinking medium.

### analyst

- No write or edit tools. systemPromptMode append: its system prompt is
  appended to the default, so lens prompts should be self-contained.
- bash allowed for read-only queries only: diff, git log, git diff, stat,
  wc, sort, uniq, grep, find, ls, cat. Never rm, mv, cp, touch, sed -i, git
  commit.
- May delegate read-only recon (for example web search) via subagent; never
  delegates builds or test runs.
- settings.json override: thinking xhigh and skills pinned to qa-adversary.
  When a prompt sets skills: [], the pin is replaced for that call.

### scout

- Tools are read, grep, find, ls only. No bash, no subagents, regardless of
  what a lens says.
- Reports presence, location, and context; never judges. A lens may regroup
  or add a relevance field but may not turn scout into a reviewer.
- settings.json override: thinking off.

### code-implementer

- Writes and edits source and test files only. disallowedTools: bash,
  subagent. No shell, no builds, no test runner; it works blind and must
  reason statically.
- Invariant: no lens supplied = no changes. Every invocation runs exactly
  one named mode defined by the lens.
- Never deletes, weakens, or skips existing tests; never touches git state.
- Handoff summary: Changed files, Verification for the coordinator, Flags
  and open questions.
- inheritProjectContext: true (the only roster agent that inherits it).

### redactor and revisor-evaluador

- Domain-specific writer and evaluator for a content pipeline. Both never
  execute anything and never invoke subagents; both work from prompts that
  carry the full inputs (outline, notes, findings).
- revisor-evaluador reads a skill path and a document path, applies the
  skill, writes JSON hallazgos, then stops without further tool calls.

## Override semantics

Six per-invocation params override an agent's resolved configuration for one
call: model, tools, skills, thinking, maxTurns, timeoutMs.

- Total replacement, not merge: tools and skills replace whatever the agent
  would otherwise resolve for that call. An omitted param means "inherit the
  resolution chain" (settings, then frontmatter, then default); passing a
  value replaces it.
- [] is a valid explicit value meaning "none" for that call. It is not the
  same as omitting the field. skills: [] in a lens prompt is the standard
  way to clear inherited skill pins.
- Placement: top-level fields in single mode; inside each tasks[] entry in
  parallel mode. [NEVER] mix a top-level override with a top-level tasks
  array.
- model: provider/modelId form; multi-slash IDs are valid. A bare alias
  without a slash is rejected with a validation error.
- thinking: off, minimal, low, medium, high, xhigh, max. An unrecognized
  level is warned and ignored, falling back to the resolved level.
- maxTurns: integer 1-100; exceeding it settles as an error and aborts the
  session. Out-of-range values are treated as no limit.
- timeoutMs: positive milliseconds; values above 2 hours are clamped with a
  warning; on expiry the run settles as an error. The default is 10 minutes.
- Default policy: [ALWAYS] omit a param unless the user explicitly asked for
  it (for example "run scout with high thinking").

## T-scout dispatch

Codebase fact lookups use scout with the T-scout template below. The
template adds the query, the search area, and the report format; the
scout's own invariants (read-only tools, no interpretation, never invent
a finding) come from its system prompt, not from the prompt. Web facts
go to web-scout with T1, never to scout.

## Template (T-scout)

Use when: the coordinator needs facts from the codebase. Web facts go to T1.

Composition: the scout agent's system prompt already defines its role
(locate and report, no analysis) and its tool set (read, grep, find, ls).
The task adds the query, the search area, and the report format.

```text
Query: <the exact fact to find>
Where: <paths or directories>

Report: path:line with an excerpt of 1-5 lines per finding. Group
findings by directory. "No results found" is a valid report.
```

## Specialized agents (not covered by the templates)

The delegation templates target the general agents above. These agents
exist in agents/ but are not targets of T1-T5; check their frontmatter
before delegating to them:

- buscador-sibdi: academic search (SIBDI-UCR), playwright browser tools + write.
- localizador-pagina: locates a textual reference in a PDF/URL (bash, read, web_read).
- verificador-dois: verifies academic metadata against DOIs (bash, read, write).
- critical-thinker: decision validation, read-only (built-in agent, not an agents/ file).
