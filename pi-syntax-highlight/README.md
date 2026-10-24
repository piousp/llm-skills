# pi-syntax-highlight

Pi extension that adds syntax highlighting to tool output and infers the language of unlabeled markdown code fences.

Scope is limited to rendering: no tool behavior, no settings, no other plugins.

## What it touches

| Tool | Change |
|---|---|
| `grep` | Paths and line numbers styled, matched line content highlighted with the language of the file, match emphasized, truncation footer preserved |
| `find`, `ls` | Directories dimmed with a trailing slash, basenames colored by file family, limit footer preserved |
| `bash`, `powershell` | Completed output styled (diffs, JSON, paths, errors), collapsed preview with the expand hint, duration line |
| `codemode`, MCP tools, unknown tools | Only when the tool has no result renderer of its own: JSON and diff bodies highlighted, anything else in the plain content color, collapsed to 10 lines with the expand hint |
| markdown fences | A fence with no info string gets a detected language injected so the existing highlighter colors it; a fence that already carries a label is never rewritten. Detection never answers `markdown` or `plaintext`, and fences tagged `mermaid`, `math`, `latex`, or `katex` are left untouched |

`read`, `write`, and `edit` are left untouched: they already highlight by file language, so their own `renderResult` is passed through and the generic overlay never applies to them.

## What it cannot do

`registerMarkdownTransformer` is a display-only `string => string` step applied before parsing. There is no extension hook that replaces the `Markdown` component from `@earendil-works/pi-tui`, so table layout, heading and list colors, code fence chrome, and column alignment are out of reach.

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
- Highlighting relies on pi's `highlightCode`, which uses the active theme; without an initialized theme the renderers fall back to plain tool output color.
- Only one markdown transformer is allowed per extension; the pipeline inside this one is a single pass.

## License

MIT
