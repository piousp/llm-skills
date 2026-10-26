# pi-syntax-highlight

Syntax highlighting for what pi prints: tool output first, then the markdown the assistant writes back. Rendering only: tool calls, results and settings stay exactly as they are.

[![npm version](https://badge.fury.io/js/pi-syntax-highlight.svg)](https://badge.fury.io/js/pi-syntax-highlight)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

```bash
pi install npm:pi-syntax-highlight
```

Start a new session and the colors are on. To try it without installing:

```bash
pi -e npm:pi-syntax-highlight
```

Needs pi 1.4 or newer. Node 24 or newer matters only for running the working copy, not for the install.

## What gets colored

| Tool | What you see |
|---|---|
| `grep` | Paths and line numbers styled, each matched line highlighted in the language of its file, the match itself emphasized. The truncation footer stays. |
| `find`, `ls` | Directories dimmed with a trailing slash, basenames colored by file family. The limit footer stays. |
| `bash`, `powershell` | Finished output styled: diffs, JSON, paths, errors. A collapsed call shows its opening lines, the expand hint, and the duration. |
| `read` | Line numbers count from the offset the read started at, not from 1, and the body is highlighted by file language. A collapsed read stays silent, the way stock pi leaves it. |
| `edit` | The diff is highlighted by file language, line numbers dimmed, changed words in reverse video. A failure paints the body in the error color. |
| `write` | The header previews the content while it streams, highlighted and capped, with the stock line footer. |
| `codemode`, MCP tools, unknown tools | Applies only where the tool has no renderer of its own. JSON and diff bodies get highlighted, anything else keeps the plain content color, and the body collapses to 10 lines with the expand hint. |
| Markdown fences | A fence with no label gets a detected language, so the block comes out colored. A fence that already carries a label is never rewritten, and `mermaid`, `math`, `latex` and `katex` are left alone. |
| Assistant markdown | Headings, blockquotes and inline code, described below. |

## Markdown styling

Headings take the theme's accent color, with one extra attribute per level so the levels stay apart; blockquote text takes the accent color too, and inline code shows its backticks again. Nothing else in the message moves, so the text reads the same once the colors are stripped.

## Limits

- A `grep` output whose own path contains `:N: ` is ambiguous, and pi does not disambiguate it either.
- No initialized theme, no color: every renderer falls back to plain tool output, and the markdown pass writes nothing.
- The accent color of a heading stops at its first inline token, so text after `**bold**` or `` `code` `` in the same heading returns to the theme heading color.
- Fence labels and fence chrome stay unstyled, and so does the `│` border of a blockquote.
- Getting the backticks back widens an inline code span, so the columns of a table that holds one are laid out again.
- Code spans with more than one backtick, setext headings, and escaped backticks are copied as they are.

## Development

```bash
npm install
npm run typecheck
npm test
```

Load the working copy from the package directory with `pi -e .`.

## More

- [DEVELOPER.md](DEVELOPER.md): how the renderers and the markdown pass are built, and the tests.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.

## License

MIT
