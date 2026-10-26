# pi-syntax-highlight: Developer Guide

How the extension draws what it draws, and why a few things stay out of reach. For installation and user-facing behavior, see [README.md](./README.md).

Needs Node 24 or newer (the tests run through `--experimental-strip-types`) and pi 1.4 or newer.

## Layout

`extensions/index.ts` is the whole public surface: it registers the tool renderers and the two markdown transformers. Everything else under `src/` is internal.

- `resolve-renderers.ts` builds the `ToolRenderers` object. One builder per tool, called from a shared wrapper that decides the theme, the error state, and the collapsed preview.
- `render-*.ts` turn a tool result into the text of a `Text` node: `grep`, `find`, `ls`, `bash`, `read`, `edit`, `write`, and `generic` (codemode, MCP, unknown tools).
- `render-utils.ts` holds the pieces those builders share: gutters, footers, the expand hint, the truncation notice.
- `highlight.ts` wraps pi's `highlightCode` with a cache, and `tokens.ts` holds the SGR sequences the code reads directly.
- `style-path.ts`, `render-path.ts`, `emphasis.ts` handle the small decisions a diff or a path needs: which color a basename gets, where the match sits inside a line, which words changed.
- `grep-parse.ts` splits grep's `path:line: text` and `path-line- text` forms. `detect-language.ts` answers a language for a fence or a file name.
- `markdown-fence-lang.ts`, `markdown-style.ts`, `markdown-theme.ts` are the markdown pass: which fence gets a label, which line gets a sequence, which palette the sequences use.
- `active-theme.ts` keeps the theme object from the last rendered tool result.

## Theme handling

The theme reaches the renderers as a proxy of stable identity, so a reference comparison never sees a theme switch. The highlight cache is keyed by the color sequences the highlighter actually reads, which changes when the theme does. `syncHighlightTheme` does the comparison on every render.

Tool failure is read from the render context, not from the result: the host passes no `isError` field inside `AgentToolResult`, so a check there is always false and no renderer ever paints an error. `render-generic` and the path renderers both read the context flag.

Without an initialized theme the renderers fall back to the plain tool output color. The markdown pass degrades the same way: with no theme captured yet, it emits no sequences at all.

## How the markdown styling works

There is no hook for the markdown theme, so the styles are written into the markdown text itself as terminal sequences, through the same transformer that labels fences. Three rules keep that contained:

- Only `assistant` messages are touched. In a user message the line background and the preserved backslash escapes would fight the injected sequences; thinking blocks keep their own default style.
- Every sequence opens and closes inside its line and closes only the attribute it opened, never with a full reset, so the style of the surrounding construct survives the span.
- The visible text is unchanged: stripping the sequences from the render leaves the same characters as the render without the transformer, except the backtick delimiters of inline code, which the stock renderer drops.

The colors come from the theme captured on the last rendered tool result, so a theme switch repaints them. A line that already carries an escape sequence is copied verbatim, which is what keeps a second pass, a Mermaid diagram, or a partially streamed message untouched.

Fence labels are chosen by `detect-language.ts`, which never answers `markdown` or `plaintext`, and leaves `mermaid`, `math`, `latex`, and `katex` alone. A fence that already carries a label is never rewritten.

## What stays out of reach

`registerMarkdownTransformer` is a display-only `string => string` step applied before parsing. There is no extension hook that replaces the `Markdown` component from `@earendil-works/pi-tui` or its theme, so table layout, list colors, and column alignment are out of reach, and the styling above is the whole of what the hook allows.

Three constructs stay out of reach even for that hook:

- Fence chrome and the language label. The info string of a fence is the language, so any sequence inside it breaks both the label and the highlighting of the body; a sequence on the closing line stops it from closing.
- The `│ ` border of a blockquote, which the renderer prepends after wrapping the content.
- The accent color of a heading stops at its first inline token: the renderer reopens its own heading color around every inline span, so text after `**bold**` or `` `code` `` in the same heading returns to the theme's heading color.

## Known limits

- `grep` output whose path itself contains `:N: ` or `-N- ` is inherently ambiguous; pi does not disambiguate it either.
- Only one markdown transformer is allowed per extension; the pipeline inside this one is a single pass.
- A `read` body records the line number where each source line starts. A source line longer than the terminal wraps, and the wrapped continuation does not repeat the gutter.
- The diff of an `edit` marks changed words only where one removed line is followed by one added line, the same rule pi applies; several removed lines keep the per-line colors.
- Restoring the backticks of an inline code span widens a table cell, so the columns of that table are laid out again.
- Code spans delimited by more than one backtick, setext headings, and escaped backticks are copied as they are.

## Tests

```bash
npm install
npm run typecheck
npm test
```

`markdown-render-parity.test.ts` is the guard on the markdown pass: it renders the same message with and without the transformer, strips the sequences, and compares the visible characters. `markdown-pipeline.test.ts` covers the fence labeling pass, `active-theme.test.ts` and `highlight.test.ts` cover the theme cache.

To try a working copy without installing it, run `pi -e .` from the package directory.

## License

MIT
