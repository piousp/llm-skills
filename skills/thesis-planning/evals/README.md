## Eval status — thesis-planning

Classification (per `evaluating-agent-skills` step 1): **preference skill**,
invoked by explicit name — `should_trigger`/negative-trigger tests don't apply.

**Layer 1 (built)**: `test_layer1_state.py` — offline unittest against
`scripts/state.py`'s real logic (chapter-status parsing, phase derivation).
Run: `python3 -m unittest evals.test_layer1_state -v`.

**Layer 2/3 (not built)**: no live trajectory probes or LLM-as-judge pass yet.
Would exercise: does the coordinator actually gate Phase 1b confirmation before
writing `outline.md`; does it ask which chapter before Phase 4a instead of
picking one; does it record back-edges (3→1, 4c→3, 4c→2) instead of silently
overwriting. **Highest-value checks**: (1) does Phase 1a/2 recon show up in the
transcript as a `web-scout` delegation naming `lens/literature-scout-lens.md`
**by path** in the invocation — not bare `web-scout` (wrong contract: no
metadata, 1 read) and not the coordinator calling `web_search`/`web_read`
directly; (2) does Phase 1b/3 show candidates arriving via a `planner`
delegation, with the coordinator presenting options rather than announcing a
choice it made itself; (3) does Phase 4a/4b show a `worker` +
`lens/chapter-drafting-lens.md` delegation, not the coordinator drafting
prose inline; (4) does the coordinator snapshot to `chapters/history/`
**before** editing and only when triggered by real external feedback, never on
a routine internal edit; (5) is feedback adjudication (`addressed`/`rejected`)
always a user decision, never a subagent's — all five are process-fidelity
requirements, not style preferences. Add if the skill is used enough to
justify the token cost — follow `iterative-design/evals/` as the worked
example.
