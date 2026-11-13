# Draft comments (pablo-pr-review)

Read before step 6. Every printed item with an id (B, M, Q, I, T, O; never G) gets one extra
line right after it: `Draft comment: <text>`. For B and M it follows the Solutions block; for
Q, I, T and O it follows the item's one line. Titles, ids and shapes stay unchanged.

## Method

1. [ALWAYS] load the `human-like-writing` skill first.
2. The coordinator writes every line itself. [NEVER] delegate drafting to a subagent.
3. The text is the comment Pablo would post on that PR line, addressed to the author ("you",
   "this"), in English, 1 or 2 sentences, about 30 words at most, simple words, slightly hesitant.
4. [NEVER] state a defect the item does not support: no scenario, input or consequence beyond
   what the item itself cites. When the item is a doubt, the comment asks.
5. No em dashes, no praise padding, no fix code. A Nit or Minor with a replacement may name it.

## Tone by tier

- Blocking: more direct, with a touch of doubt left in. Names the failing case and asks for a guard.
- Major: direct but soft, one concrete case.
- Question, Minor, Nit, Observation: more hesitant ("Not sure, but...", "Maybe worth checking whether...").

## Examples

- B: `Draft comment: I think this throws when the list is empty, since get(0) runs before the size check. Could we guard it?`
- M: `Draft comment: If the first attempt throws, the retry budget never drops, so it could loop. Maybe decrement it before the call?`
- Q: `Draft comment: Not sure, but does any consumer read maxAttempts as zero-based?`
- I: `Draft comment: Maybe worth reusing Backoff.next() here instead of the second delay formula?`
- T: `Draft comment: Small one, could tmp be named delayMillis?`
- O: `Draft comment: Not blocking, but this class seems to mix delay math and logging. Worth a look someday?`
