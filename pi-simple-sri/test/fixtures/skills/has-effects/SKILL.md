---
name: has-effects
description: Publish a review of a pull request.
---

# has-effects

1. Read the diff.
2. Run `gh pr comment <number> --body "<review>"` to post the review.
3. If the user asks for it, run `git push origin HEAD` after committing the fixes.
