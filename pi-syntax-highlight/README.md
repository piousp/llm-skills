# pi-syntax-highlight

Pi extension that adds syntax highlighting to tool output and to assistant markdown: tool renderers for `grep`, `find`, `ls`, the shells, `read`, `edit` and `write`, and a markdown pass that colors headings, blockquotes and inline code without changing the text.

Scope is limited to rendering: no tool behavior, no settings, no other plugins.

## What it touches

| Tool | Change |
|---|---|
| `grep` | Paths and line numbers styled, matched line content highlighted with the language of the file, match emphasized, truncation footer preserved |
| `find`, `ls` | Directories dimmed with a trailing slash, basenames colored by file family, limit footer preserved |
| `bash`, `powershell` | Completed output styled (diffs, JSON, paths, errors), collapsed preview with the expand hint, duration line |
| `read` | Call header with path and line range; expanded body numbered from the real line the tool read (`offset`), highlighted by file language, continuation and truncation notices in the warning color; a collapsed call stays silent like stock pi |
| `edit` | Diff highlighted by file language, line numbers dimmed, changed words in reverse video; the diff fills the body of the call's box, whose background follows success or failure |
| `write` | Header preview of the content, highlighted and capped while the argument is still arriving, with the stock line footer; failures in the error color |
| `codemode`, MCP tools, unknown tools | Only when the tool has no result renderer of its own: JSON and diff bodies highlighted, anything else in the plain content color, collapsed to 10 lines with the expand hint |
| markdown fences | A fence with no info string gets a detected language injected so the existing highlighter colors it; a fence that already carries a label is never rewritten. Detection never answers `markdown` or `plaintext`, and fences tagged `mermaid`, `math`, `latex`, or `katex` are left untouched |
| assistant markdown | Headings in the theme's accent color with one attribute per level, inline code with its backtick delimiters visible, and blockquote text in the accent color |

## How the markdown styling works

There is no hook for the markdown theme, so the styles are written into the markdown text itself as terminal sequences, through the same transformer that labels fences. Three rules keep that contained:

- Only `assistant` messages are touched. In a user message the line background and the preserved backslash escapes would fight the injected sequences; thinking blocks keep their own default style.
- Every sequence opens and closes inside its line and closes only the attribute it opened, never with a full reset, so the style of the surrounding construct survives the span.
- The visible text is unchanged: stripping the sequences from the render leaves the same characters as the render without the transformer, except the backtick delimiters of inline code, which the stock renderer drops.

The colors come from the theme captured on the last rendered tool result, so a theme switch repaints them; a line that already carries a sequence is copied verbatim, which is what keeps a second pass, a Mermaid diagram, or a partially streamed message untouched.

## What it cannot do

`registerMarkdownTransformer` is a display-only `string => string` step applied before parsing. There is no extension hook that replaces the `Markdown` component from `@earendil-works/pi-tui` or its theme, so table layout, list colors, and column alignment are out of reach, and the markdown styling above is the whole of what the hook allows.

Three constructs stay out of reach even for that hook:

- Fence chrome and the language label. The info string of a fence *is* the language, so any sequence inside it breaks both the label and the highlighting of the body; a sequence on the closing line stops it from closing.
- The `│ ` border of a blockquote, which the renderer prepends after wrapping the content.
- The accent color of a heading stops at its first inline token: the renderer reopens its own heading color around every inline span, so text after `**bold**` or `` `code` `` in the same heading returns to the theme's heading color.

## Development

Requires Node 24+ and pi 1.4+.

```bash
npm install
npm run typecheck
npm test
```

Load it into a session without installing:

```bash
pi -e /home/pablo/LLMs/pi-syntax-highlight/extensions/index.ts
```

## Known limitations

- `grep` output whose path itself contains `:N: ` or `-N- ` is inherently ambiguous; pi does not disambiguate it either.
- Highlighting relies on pi's `highlightCode`, which uses the active theme; without an initialized theme the renderers fall back to plain tool output color. The markdown styling degrades the same way: with no theme captured yet it emits no sequences.
- Only one markdown transformer is allowed per extension; the pipeline inside this one is a single pass.
- A `read` body records the line number where each source line starts. A source line longer than the terminal wraps, and the wrapped continuation does not repeat the gutter.
- The diff of an `edit` marks changed words only where one removed line is followed by one added line, the same rule pi applies; several removed lines keep the per-line colors.
- Restoring the backticks of an inline code span widens a table cell, so the columns of that table are laid out again.
- Code spans delimited by more than one backtick, setext headings, and escaped backticks are copied as they are.

## License

MIT
