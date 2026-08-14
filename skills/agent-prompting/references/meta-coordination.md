# Meta-coordination (T5): transparency, digest, deferrals

This reference expands template T5 in the skill's SKILL.md. T5 is the only
template whose recipient is the user, not a subagent: it governs how the
coordinator shows prompts before delegating and how it reports subagent
returns. It covers preview, digest, and deferrals only.

## Preview discipline

[ALWAYS] ask before delegating: "¿Muestro el prompt antes de delegar?
(sí / no)". The string is fixed; keep it verbatim.

- If yes: show the exact prompt in a quoted block, wait for the user's
  approval, then send it.
- If no: send without showing. The assembled prompt is the same either way;
  the question is only about display.
- The prompt sent is [ALWAYS] the one shown. No rewrites after preview. If
  the coordinator wants to change anything after showing, it shows the new
  version and asks again.
- Why: the user approves a specific instruction to a subagent. Any rewrite
  after approval sends an instruction nobody approved, and the digest that
  comes back will not match what was approved.

## Digest of findings

After a subagent returns, the coordinator reports the result as a digest,
not as a transcript.

- Bullets only, condensed. [NEVER] repeat the response verbatim.
- Keep the actionable parts: verdict, severities, file:line references, and
  the one-line "what I could not verify" when the lens produced one.
- No findings: one line saying so. An empty digest is a valid digest.
- If the coordinator disagrees with a finding, say so briefly; do not bury
  the finding to make the disagreement invisible.

## Deferrals stay visible

Anything the subagent flagged as out of scope, blocked, or postponed is a
deferral. It must appear in the digest, never in a silent drop.

Format: "Deferral: <item> - <reason> - revisit when <trigger>".

Examples:

- Deferral: migration script for legacy rows - out of seam scope - revisit
  when the invoice-total work lands
- Deferral: InvoiceTest naming cleanup - not this change's concern - revisit
  in the refactor pass

Deferrals are how the coordinator keeps a thread alive across delegations
without re-reading every return. If a deferral has no trigger, say "revisit
when the coordinator decides" or drop it explicitly; do not leave it
floating invisibly.

## Boundary with pablo-toolkit

T5 owns preview, digest, and deferrals. Two things stay in pablo-toolkit:

- Tree views: after a step that modifies files, pablo-toolkit shows what
  changed; T5 does not duplicate it.
- Session close and the continuation block: closing the session and building
  the continuation handoff is pablo-toolkit's job.

If the coordinator runs pablo-toolkit, T5's digest and the toolkit's tree
view coexist without overlap: the digest summarizes findings, the tree view
shows files.

## Anti-patterns

- Showing the prompt without asking first.
- Rewriting the prompt after a preview.
- Repeating full responses back to the user.
- Emojis.

## Example

User: "Delega la busqueda al web-scout."

Coordinator: "¿Muestro el prompt antes de delegar? (sí / no)"

User: "sí"

Coordinator shows the exact T1 prompt in a quoted block. User approves.
Coordinator sends it.

web-scout returns a JSON of claims. Coordinator digests:

- Verified: pi-simple-agents supports parallel subagent tasks - 3
  independent sources, access_date 2026-08-14
- Could not verify: current ceiling for parallel tasks
- Deferral: verify the parallel ceiling in the docs - web-scout hit its stop
  rule first - revisit when the number matters for a fan-out decision

## Template (T5)

Use when: a delegation is about to be sent, or a subagent has returned.

```text
Before delegating: [ALWAYS] ask the user: "¿Muestro el prompt antes de
delegar? (sí / no)". If yes: show the exact prompt in a quoted block,
wait for approval, then send it. The prompt sent is [ALWAYS] the one
shown; no rewrites after preview.

After a subagent returns:
- Digest the findings in bullets. [NEVER] repeat the response verbatim.
- No findings: one line saying so.
- Deferrals stay visible: "Deferral: <item> - <reason> - revisit when
  <trigger>".

Anti-patterns:
- Showing the prompt without asking first.
- Rewriting the prompt after a preview.
- Repeating full responses back to the user.
- Emojis.

Boundary: tree views and session close belong to pablo-toolkit; this
template covers preview, digest, and deferrals only.
```
