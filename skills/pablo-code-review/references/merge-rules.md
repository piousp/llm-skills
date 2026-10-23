# Merge rules (pablo-code-review)

Read before step 4 (merge). Every lens item lands in exactly one tier or one uncounted list
(evidence: `lessons-learned.md`, 2026-10-23 entry).

## Tier map

Major (M) means "a comment worth posting"; its title is that comment.

| Lens item | Report tier |
|---|---|
| qa-adversary BLOCK/HIGH passing the Blocker gate | Blocking (B) |
| qa-adversary BLOCK/HIGH/MEDIUM whose scenario needs a premise outside the diff | Question (Q) |
| qa-adversary MEDIUM, premise in the diff | Major (M) |
| qa-adversary LOW | Minor (I) |
| qa-adversary Open Question | Question (Q) |
| qa-adversary Integration Coverage NOT COVERED / PARTIAL | Coverage gap (G) |
| checklist Blocker passing the Blocker gate | Blocking (B); failing it: Major (M) |
| checklist Major on production code | Major (M) |
| checklist Minor | Minor (I) |
| checklist Question | Question (Q) |
| checklist Nit | Nits line (T) |
| checklist FYI | dropped; build metadata: the one FYI line (Routing) |
| pablo-test-review Major | Major (M) |
| pablo-test-review Question | Question (Q) |
| pablo-test-review Minor | Minor (I) |
| pablo-test-review Nit | Nits line (T) |
| pablo-test-review Coverage gap | Coverage gap (G); never Blocking |
| refactor-identification P1 | Minor (I); Major (M) only merged with a qa/checklist Major on the same root cause |
| refactor-identification P2/P3 | Observations line (O) |
| refactor-identification Unresolved | Question (Q) if the answer could make it P1; else dropped |
| any lens Filtered out | never printed |

Older checklist test/coverage items no longer exist: test quality and coverage belong to
`pablo-test-review`; drop any such item an older checklist still emits.

Dedupe vs qa-adversary: same `file:line` and same root cause → one item tagged with both
lenses; its tier is qa-adversary's only if qa supplied a production failure scenario, else
the test lens's.

Disagreement on a merged item: take the tier of the lens that gave a concrete in-diff failure
scenario; without one, the lower tier. Doubt never raises a tier.
Verdict: BLOCK iff ≥1 B; NEEDS WORK iff ≥1 M; else PASS. Q, I and G never change it.

## Blocker gate

Blocking needs every premise of the failure scenario visible in the diff or 1 hop away in the
same repo. A premise marked "pending grep" or "could not run", or resting on another repo,
deploy order, environment config or an unread consumer, fails the gate: the item becomes a
Question whose text is the question to post plus the lookup that settles it. A config file or
snapshot in the local checkout is not evidence of deployed state.

## Root cause

The single definition; every lens points here. One item = one root cause = the one fix that
removes it. Items from any lens that one fix removes merge into one item tagged with every
lens. Structural violations in the same method (length, nesting, complexity) are one item;
when the excess predates the diff it is Minor. An item that needs two independent fixes is
two items.

## Routing

- Build metadata (SNAPSHOT, ticket-qualified or feature-branch versions of same-org
  artifacts, CI files): at most one `**FYI (not counted):**` line in the Summary; never
  B/M/Q/I. Consistency check: when context or sibling PRs are known, a MISMATCH of the
  snapshot version across them is a concrete Major; otherwise only the FYI line.
- Test strength: owned by `pablo-test-review`; take its tier as given (Tier map). Naming the
  missing assertion/test is part of its finding, not a correction.
- Scope: an element outside the declared objective(s) is one Minor item, phrased as a
  question and anchored on its first added line ("Why X in this PR?"); never lead with
  "split the PR". Reformat-only and .gitignore hunks go to Nits.
- Outside the diff: an item anchored outside the diff, or needing state outside it, is a
  Question with its lookup, or dropped past the cap. Never a finding.
- Scripts (Python, shell): reviewed only if the repo shows they run in CI or production (CI
  config, Dockerfile, entrypoint); otherwise one Observations line names them.
- Package cycles: never findings. Report them as one `Data:` line at the end of the report.

## Caps

- Questions: at most 3. Each one gates a B/M (its answer would create or remove one), is
  anchored on a changed line, and reads as the comment to post plus "What to check". Run any
  read-only lookup that could answer it first. Past the cap, keep those gating the highest
  tier. Domain-knowledge questions no lookup can answer go in the single line under
  `### Unverified business assumptions`. If the user answers one: business knowledge becomes
  a Wiki proposal, repo-specific knowledge a repo lesson; always with the user's approval.
- Coverage gaps: qa-adversary NOT COVERED/PARTIAL lines and pablo-test-review gaps are one
  list, at most 3, using the test lens's ranking. Only critical ones, ranked: new branch with no test > changed
  behavior tested only for the old behavior > edge case. Each: file:line, input → expected,
  suggested test name. Deduplicate across lenses; skip QA/dev-only tooling.
- Nits: only with the exact replacement. Strengths: optional, 1-2 concrete
  lines (what is done well and where), only if genuine; never counted in tally or verdict.

## Format by tier

Every printed item's head is `**<id> [<tier> - <lens(es)>] <location>: <text>**` (B, M, Q, I,
G, T, O alike). Ids are numbered by tier, then rank, across the whole report; within a file
items print by tier, then id.

Four-part (What / Why it happens / Consequences / Solutions ≥2) for B and M only. "Why it
happens" gives ≥2 concrete input scenarios for behavior findings, one concrete case for
structural ones, never a hypothetical future change. Question: one line. Minor: one line
with at least one concrete suggestion (replacement or comment-ready text). Shapes in
SKILL.md Output format. A file with no findings gets one line under "Other files"; only files
with findings get the "What this code does" walkthrough and the diff hunk. Every title is the comment to post, plain language first.

## Re-review

When the user already commented on the PR:
1. `gh api --hostname <host> user -q .login`, then
   `gh api --hostname <host> --paginate repos/<org>/<repo>/pulls/<n>/comments`, filtered to
   that login, and read the previous report(s) in `reviews/<repo>/pr<n>-r*.md`.
2. Open the report with a table, one row per prior comment or prior item. The status table
   has EXACTLY three columns: `Prior item | Title | Status` (Status = `resolved` | `open` |
   `outdated`, optionally with a short reason after a colon). A full re-run adds no extra
   column and no prose line between the Summary and the first file section.
3. Full treatment only for new findings and findings on lines changed since the last round;
   unchanged prior items appear only in the table. Cite current-round ids only if they are
   printed in the report; in a re-review prior items are always cited as `r<k>:<id>`.

### No new commits

If the PR head sha equals the previous round's `head_sha` and the user did not ask for a full
re-run, print exactly this and nothing else: no preamble, notes, decisions or extra tables.
1. The line `No changes since round r<k> (head <sha7>).`
2. The status table of the prior comments (three columns `Prior item | Title | Status`,
   prior ids cited as `r<k>:<id>`).

Print nothing after the status table: no notes, explanations of where statuses came from,
offers or questions.

Do not dispatch lenses and do not write a new ledger round. If the user asks for a full
review or a re-run ("full review", "run it again"), run the complete pipeline as a new round
even when the head is unchanged.

### Rebased or force-pushed PR

If the previous round's `head_sha` is not in the PR history, there is no incremental diff:
1. Say `PR was rebased; no incremental diff` in the Summary.
2. Match each prior item to the current findings by file path and root cause.
3. A prior OPEN item whose cited code is textually unchanged stays a status-table row
   (`open, carried over`), never a new finding.
4. Only new findings and findings on changed code get full treatment.
