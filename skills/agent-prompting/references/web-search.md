# Web Search Delegation (T1)

Reference file for the T1 web-search template in SKILL.md. Read this when
the coordinator needs web facts, research topics, or claim verification.
The template lives at the end of this file; the sections below carry the
evidence, the failure taxonomy, and a worked example.

## Use when / Do NOT use when

Use when:

- The coordinator needs facts that live on the web.
- A claim needs verification against independent sources.
- Research must come back as a digest with citations.

Do NOT use when:

- The facts live in the codebase: use T-scout instead.
- The answer is already in the coordinator context.
- The coordinator already has the sources open and can read them
  directly.

## 1. Lessons from the process finding, with evidence

The T1 template exists because real delegations failed in specific,
repeatable ways. Every lesson names the observed failure and the rule
that fixes it.

### 1.1 The local lens failure: the output contract must be INLINE

A lens passed by path is fragile for a web-scout: the agent's 10-call
budget makes a lens read expensive, a failed read costs a call with no
contract loaded, and the contract is invisible in the transparency
preview. In the process finding, the lens file was unreadable (the agent
lacked read at the time) and the delegation stalled with no fallback
contract.

Rule: [ALWAYS] put the full output contract and the rules INLINE in the
prompt, as T1 does. [NEVER] pass a lens path to a web-only agent. For a
web-scout, the prompt is the only artifact the agent can rely on.

### 1.2 Hard ceiling of 10 tool calls

An agent without a stop rule keeps searching. In the process finding, a
run without a ceiling spent calls on redundant queries and returned
late.

Rule: give the explicit stop rule (3 independent sources OR 4 queries,
whichever comes first) and a hard ceiling of 10 tool calls. [NEVER]
search past the ceiling; record what was tried and stop.

### 1.3 Reader truncation at ~27k characters

Jina-style readers truncate page content. A long page read through one
reader came back cut at roughly 27k characters, and the missing tail
contained the evidence. A summary built from the truncated read was
wrong.

Rule: treat one reader as one attempt. If the content is truncated and
the evidence is not in what you got, retry once with a different reader.
Then drop the URL and record it in urls_attempted.

### 1.4 Reddit returns 403

Reddit blocks the default readers. In the process finding, Reddit URLs
consistently returned 403 Forbidden, wasting attempts.

Rule: expect 403 on Reddit. A blocked URL is not a negative result for
the claim; record it in urls_attempted and find an independent
alternative source for the same fact.

### 1.5 Alternative readers rate-limit (429)

Fallback readers are rate-limited. Firecrawl-style readers returned 429
under repeated use.

Rule: one retry with a different reader, then drop. Burning more calls
on the same URL is waste; move to another source and record the
failure.

## 2. Reformulate the query (recall 0.52 to 0.81)

The raw question as the user phrased it is a poor search query. In the
process finding, searching the raw question verbatim reached a recall of
about 0.52; reformulating into 2-4 concrete queries raised recall to
about 0.81.

How to reformulate:

- Extract the concrete nouns from the question.
- Add synonyms for the key terms.
- Add scope or date terms to narrow the result set.
- Split a compound question into separate queries.

[NEVER] search the raw question verbatim. T1 requires 2-4 reformulated
queries and records them in queries_tried.

Example. Raw question: "Is AI being regulated in Europe?" Reformulates
into:

- "EU AI Act high-risk AI requirements"
- "AI Act 2024/1689 human oversight article 14"
- "EU AI regulation timeline 2025 2026"
- "AI Act penalties for non-compliance"

## 3. Decompose into subqueries

A claim is rarely one atomic fact. T1 asks for subclaims so the agent
can verify each part and report partial status. Decomposition turns
"verify X" into "verify X1, X2, X3", each searchable and independently
verifiable.

Decomposition rules:

- Each subclaim must be falsifiable: a source can confirm or contradict
  it.
- Subclaims must be independently sourced; do not chain them so that one
  source proves all of them.
- Keep the list short (2-4). The stop rule counts sources for the claim
  set, not per subclaim.

## 4. Triangulate 3+ independent sources

A single source can be wrong, derivative, or astroturfed. T1 requires 3+
independent sources for a "verified" status.

Independence rules:

- Two pages that copy the same original (aggregators, press-release
  mirrors) count as one source.
- The original regulation, the regulator's own page, a reputable
  journalist report, and an academic summary count as four.
- If 3 independent sources cannot be reached in budget, report
  "partial" in could_not_verify. [NEVER] upgrade to "verified" on fewer.

## 5. Verify against the original source

A snippet, a summary, or the agent's own earlier paraphrase is not
evidence. The process finding showed an agent producing a plausible
corroboration list by verifying against its own summary.

Rule: [ALWAYS] verify each claim against the original page content, not
against a snippet or a summary of it. If the original cannot be read
(truncated, 403, 429), the claim stays "partial" or "unverified".

## 6. The anti-invented-sources invariant

The worst failure is a fabricated URL or a claim attributed to a page
the agent never read. It looks like evidence and is indistinguishable
from truth in the output.

Invariant with the reason: [NEVER] report a source you did not read;
[NEVER] invent a URL. Reason: a corroboration URL that was never opened
is not corroboration; it is noise that poisons the digest. Record every
attempted URL in urls_attempted, including failures, so the coordinator
can see what was tried.

## 7. Taxonomy of web delegation failures

| Symptom | Cause | Fix in the prompt |
|---|---|---|
| Low recall, irrelevant hits | Raw question searched verbatim | 2-4 reformulated queries |
| Delegation stalls or misapplies | Lens path given to a web-only agent | INLINE contract, no lens |
| Calls exhausted, late return | No stop rule | 3 sources OR 4 queries, ceiling 10 |
| Wrong conclusion | Reader truncated the page ~27k chars | Retry once with another reader, then drop |
| Reddit URLs always fail | Reddit blocks readers with 403 | Record in urls_attempted, use alternatives |
| Fallback reader refuses | Rate limit 429 | One retry, then drop and move on |
| Corroboration looks real but is false | Verified against the agent's own summary | Verify against the original page |
| Fabricated URL in output | No anti-invention invariant | [NEVER] report unread sources |
| "Verified" on one aggregator farm | Derivative sources counted as independent | 3+ independent origins |

Delegation-level failure: when the first run comes back unusable, do not
rephrase the same prompt. Check the taxonomy: which block was missing?
Fix that block and resend once. A second failure at the same point means
the mechanism is wrong, not the wording: stop and change the mechanism
(different agent, inline extraction, or the coordinator reads directly).

## 8. Worked example

The coordinator needs to verify a claim before quoting it in a report.

Filled T1 prompt:

```
Objective: verify the claim "The EU AI Act entered into force on 1
August 2024 and requires human oversight for high-risk AI systems."
Verify these subclaims:
- The EU AI Act entered into force on 1 August 2024.
- The Act requires human oversight for high-risk AI systems.
- Obligations apply gradually, with full application by mid-2026.

Reformulate: rewrite the raw question into 2-4 search queries. Use
concrete nouns, synonyms, and scope or date terms. A poorly phrased
query loses recall; [NEVER] search the raw question verbatim.
- "EU AI Act entry into force 1 August 2024"
- "AI Act high-risk AI human oversight requirement"
- "Regulation 2024/1689 human oversight article 14"
- "EU AI Act full application August 2026"

Output contract: report findings as JSON only, with these fields:
{
  "claims": [
    {
      "claim": "<the verified claim>",
      "corroboration_urls": ["<url>", "<url>"],
      "independent_sources": <int>,
      "status": "verified" | "partial" | "unverified",
      "access_date": "<YYYY-MM-DD>"
    }
  ],
  "could_not_verify": ["<claim or question left open>"],
  "queries_tried": ["<query>", "<query>"],
  "urls_attempted": ["<url>", "<url>"]
}

Stop rule: stop when 3 independent sources support the claim OR after 4
queries, whichever comes first. The agent's own 10-call ceiling always
applies.

Limits:
- Triangulate: 3+ independent sources; two pages derived from the same
  original do not count as independent.
- Verify against the original source, never against a snippet or a
  summary of it.
- No commentary outside the JSON.
```

What a good return looks like (URLs shown as shape only; the agent fills
real ones it actually read):

```json
{
  "claims": [
    {
      "claim": "The EU AI Act entered into force on 1 August 2024.",
      "corroboration_urls": [
        "https://eur-lex.europa.eu/<original regulation page>",
        "https://digital-strategy.ec.europa.eu/<commission page>",
        "https://<news report>"
      ],
      "independent_sources": 3,
      "status": "verified",
      "access_date": "2026-08-14"
    },
    {
      "claim": "The Act requires human oversight for high-risk AI
systems.",
      "corroboration_urls": [
        "https://eur-lex.europa.eu/<original regulation page>"
      ],
      "independent_sources": 1,
      "status": "partial",
      "access_date": "2026-08-14"
    }
  ],
  "could_not_verify": [
    "Obligations apply gradually, with full application by mid-2026"
  ],
  "queries_tried": [
    "EU AI Act entry into force 1 August 2024",
    "AI Act high-risk AI human oversight requirement",
    "Regulation 2024/1689 human oversight article 14",
    "EU AI Act full application August 2026"
  ],
  "urls_attempted": [
    "https://eur-lex.europa.eu/<original regulation page>",
    "https://digital-strategy.ec.europa.eu/<commission page>",
    "https://<news report>",
    "https://<press-release aggregator>"
  ]
}
```

How this run went, in prose: the agent reached 3 independent sources for
subclaim 1 and stopped the search there. One aggregator URL returned
403, so the agent retried it once with a different reader, then dropped
it and recorded it in urls_attempted. The third subclaim did not get its
own independent sources within budget, so it sits in could_not_verify as
"partial" instead of being asserted. Total tool calls were 9, inside the
ceiling of 10.

## Template (T1)

Use when: the coordinator needs web facts, research topics, or claim
verification. Do NOT use when: the facts live in the codebase (T-scout), the
answer is already in context, or the coordinator has the sources open.

Composition: the web-scout agent's own system prompt already defines its
role, its invariants (no fabricated sources, 10-call ceiling, per-URL read
policy) and its no-results JSON. The task adds only what the agent does not
know: the objective, the claims, the output contract, and the case-specific
stop rule and limits.

```text
Objective: <one sentence: the claim or topic to verify>. Verify these
subclaims:
- <subclaim 1>
- <subclaim 2>

Reformulate: rewrite the raw question into 2-4 search queries. Use
concrete nouns, synonyms, and scope or date terms. A poorly phrased
query loses recall; [NEVER] search the raw question verbatim.

Output contract: report findings as JSON only, with these fields:
{
  "claims": [
    {
      "claim": "<the verified claim>",
      "corroboration_urls": ["<url>", "<url>"],
      "independent_sources": <int>,
      "status": "verified" | "partial" | "unverified",
      "access_date": "<YYYY-MM-DD>"
    }
  ],
  "could_not_verify": ["<claim or question left open>"],
  "queries_tried": ["<query>", "<query>"],
  "urls_attempted": ["<url>", "<url>"]
}

Stop rule: stop when 3 independent sources support the claim OR after 4
queries, whichever comes first. The agent's own 10-call ceiling always
applies.

Limits:
- Triangulate: 3+ independent sources; two pages derived from the same
  original do not count as independent.
- Verify against the original source, never against a snippet or a
  summary of it.
- No commentary outside the JSON.
```
