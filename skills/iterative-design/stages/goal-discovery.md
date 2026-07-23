# Goal Discovery

Interview the user relentlessly about every aspect of this until we reach a shared understanding for
the goal (the decision this work drives, not the task named). Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking the user. The *decisions*, though, are the user's — put each one to them and wait for their answer.

Do not act on it until the user confirms we have reached a shared understanding.

## Exit criteria

Goal is discovered and 100% understood and unambiguous.

On confirmation, the coordinator writes `.design/goal.md` — the original prompt verbatim plus
the discovery outcome — and seeds `.design/decisions.md` with its first entry (goal confirmed,
plus any load-bearing decisions taken during discovery).
