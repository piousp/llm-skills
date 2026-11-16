# pi-syntax-highlight: Developer Guide

How the extension draws what it draws, and why a few things stay out of reach. For installation and user-facing behavior, see [README.md](./README.md).

Needs Node 24 or newer (the tests run through `--experimental-strip-types`) and pi 1.5.1 or newer.

## Layout

`extensions/index.ts` is the whole public surface: it registers the tool renderer resolver and one markdown transformer (messages `assistant`, `assistant-thinking`, `custom`, `summary`). Everything else under `src/` is internal.

- `resolve-renderers.ts` is the resolver; see below.
- `render-*.ts` turn a tool result into the text of a `Text` node: `grep`, `find`, `ls`, `bash`, `read`, `edit`, and `generic` (extension tools without a result renderer).
- `render-utils.ts` holds the pieces those builders share: footers, the expand hint, the truncation notice.
- `highlight.ts` wraps pi's `highlightCode` with a cache, and `tokens.ts` holds the SGR sequences the code reads directly.
- `style-path.ts` and `emphasis.ts` handle the small decisions a path or a grep line needs: which color a basename gets, where the match sits inside a line (with the length and backtracking guards).
- `grep-parse.ts` splits grep's `path:line: text` and `path-line- text` forms. `detect-language.ts` answers a language for a fence, and `detectOutputLanguage` answers one for a tool-output body.
- `markdown-fence-lang.ts` is the markdown pass: it labels unlabeled closed fences and nothing else.

## The resolver

`resolveToolRenderers` wraps the host chain: it calls `next()` and decides per tool.

- No base renderers: `undefined` passes through.
- Base with no `renderResult`: the generic renderer is installed.
- Otherwise the slot is overlaid only if it is the stock one. Detection is by identity against the host's own `create*ToolDefinition(cwd)` result, then by `toString()` equality, because the stock `bash` and `powershell` renderers are built per definition. Anything undecidable counts as foreign and is returned unchanged, so MCP tools and extensions that bring their own renderer keep it.
- Styled slots: `grep`, `find`, `ls`, `read` (result only), `edit` (the highlighted diff is swapped into the box stock filled), `bash`/`powershell` (final results only; partial results stay on stock, which owns the elapsed line and repaint interval).
- Every overlay is wrapped: if ours throws, stock renders the result with a fresh component; the generic renderer falls back to the plain body.
- `write`, and the `read`/`write` call headers, are stock. Error results are delegated to stock.
- The key hint comes from `context.keyHint`, with `rawKeyHint` as the fallback outside a session.

The overlays depend on host internals, and contract tests fail when pi renames them: `state.callComponent` (edit's call box, header first), `state.startedAt` and `state.interval` (shell clock).

## Theme handling

The theme reaches the renderers as a proxy of stable identity, so a reference comparison never sees a theme switch. The highlight cache is keyed by the color sequences the highlighter actually reads, which changes when the theme does. `syncHighlightTheme` does the comparison on every render. Nothing captures the theme for the markdown pass, which writes no colors.

Tool failure is read from the render context, not from the result: the host passes no `isError` field inside `AgentToolResult`, so a check there is always false.

Without an initialized theme the renderers fall back to the plain tool output color.

## How a bash body gets its language

Diff and JSON are recognized over the whole body. Anything else goes to `detectOutputLanguage`, which wraps the fence detector with an allowlist and two raised thresholds, because shell output is log-shaped far more often than code-shaped. Three false positives decided that design, all measured: two `key: value` lines are `git log`, `curl -I` headers are a YAML document to any count that ignores case, and "Update the docs in the table from last week" is SQL. A wrong label paints the body with a grammar that does not fit it, which reads worse than flat text.

Detection reads the first `HIGHLIGHT_LINE_BUDGET` lines, the same lines the tokenizer will paint, so nothing is detected in a region that would stay flat anyway. A classified line (error, warning, `path:line:`) replaces the highlighted one instead of being wrapped inside it: `theme.fg()` closes at the end of the string and cannot recolor a span of an already painted line.

`render-generic` does not use the detector. It recognizes JSON and diff only, and anything else keeps the plain content color.

## The markdown pass

`registerMarkdownTransformer` is a display-only `string => string` step applied before parsing. This package uses it for one thing: the info string of a closed fence with no label gets a detected language, so pi's own highlighter has a grammar. The pass is memoized (small LRU), copies an unclosed fence as it is because its body is still arriving, never rewrites an existing label or a body that already carries escape sequences, and falls back to the original markdown if it throws.

Labels are chosen by `detect-language.ts`, which never answers `markdown` or `plaintext`, and leaves `mermaid`, `math`, `latex`, and `katex` alone. There is no hook that replaces the `Markdown` component, so headings, quotes, inline code, tables and lists are outside this package.

## Known limits

- Fences inside lists or blockquotes are not recognized, so they are not labeled.
- A bash body is read once, from its head: a log that turns into YAML after the first `HIGHLIGHT_LINE_BUDGET` (400) lines keeps the flat paint. The cap applies to bash only.
- A lowercase SQL query with no terminator stays flat, which is the price of rejecting English prose that starts with "Update" or "Delete".
- `properties` is detected in fences only; it is not in the bash allowlist.
- HTML fragments need a known lowercase tag and a closing tag; JSX without `className=` or `={` can be detected as HTML.
- `grep` output whose path contains `:N: ` or `-N- ` is ambiguous; pi does not disambiguate it either. Emphasis is skipped for lines over 500 characters and for backtracking-prone patterns.
- The diff of an `edit` marks changed words only where one removed line is followed by one added line, the same rule pi applies.
- Only one markdown transformer is registered by this extension.

## Tests

```bash
npm install
npm run typecheck
npm test
```

Seams the tests rely on:

- `stock-parity.test.ts` renders the same input through stock pi and through the resolver and compares text and shape (errors, read/write calls, generic fallback, edit diff).
- `resolve-renderers.test.ts` covers slot detection, fallback to stock on error, the shell clock, and the contract tests on `state.callComponent`, `state.startedAt` and `state.interval`.
- `markdown-fence-lang.test.ts` and `markdown-render-parity.test.ts` cover the fence labeling and that the visible text is unchanged.
- `extensions-index.test.ts` covers what is registered.
- `highlight.test.ts` covers the theme cache; builders take an injected highlighter because `highlightCode` reads the module-global theme.
- `emphasis.test.ts` includes the backtracking guard.

To try a working copy without installing it, run `pi -e .` from the package directory. With `node_modules` present the extension can import a second copy of pi next to the host's: `keyHint` therefore comes from the render context, never from a module-level import, and languages beyond the eager set (about 21) are registered asynchronously, so the first render of a rarer language can be flat.

## Release

The package is published from `.github/workflows/publish-syntax-highlight.yml`, which lives at the root of the
monorepo and runs with `working-directory: pi-syntax-highlight`. It is triggered by hand only
(`workflow_dispatch`), over OIDC with `npm stage publish`. There is no `NPM_TOKEN`: the npm CLI exchanges the
runner's OIDC identity for a short-lived publish token. The trust relationship is configured on npmjs.com and
names the exact filename of that workflow, so renaming it breaks publishing until the connection is deleted and
created again. The publish stays in stage and goes to production when a person approves it on npmjs.com.

The job order is `npm ci`, `npm run typecheck`, `npm test` and `npm stage publish`. The version published is the
one in `package.json` at that commit, so a release is a version bump committed to `main`, a push and then the
dispatch; a version already on the registry fails the last step and leaves nothing staged.

## License

MIT
