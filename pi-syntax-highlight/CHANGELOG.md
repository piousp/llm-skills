# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog, and this project uses semantic versioning.

## [Unreleased]

### Fixed

- Stack traces and RFC822 folded headers are no longer labeled `makefile`.
  Cost: a target whose last segment starts with a capital letter (e.g. `Main:`)
  is no longer detected as makefile.
- The fence-label transformer runs for `user` messages again.

## [0.2.1] - 2026-11-16

### Added

- `publish-syntax-highlight` GitHub Actions workflow: manual dispatch, OIDC trusted
  publishing with `npm stage publish`, after typecheck and tests.
- `package.json` gains a `files` allowlist (`extensions`, `src`, `README.md`,
  `CHANGELOG.md`, `DEVELOPER.md`, `LICENSE`), and the repo gains the MIT
  `LICENSE` file its manifest already declared.

### Changed

- `test/` and `assets/` are no longer published (43 → 22 files; 104 → 39 KB
  packed).

## [0.2.0] - 2026-11-16

### Removed

- Markdown styling of assistant messages (heading colors, blockquote text,
  restored inline-code backticks). The markdown transformer now only labels
  unlabeled closed fences.
- The `read` line-number gutter and the `write` content overlay.
- Fence info strings are now copied as written, so `{.ts}` and `js title="a"`
  are no longer normalized.

### Changed

- Requires pi 1.5.1 or newer.
- The markdown transformer also runs for `assistant-thinking`, `custom` and
  `summary` messages.
- Colors follow stock pi (`toolOutput`), so a restyled result looks like the
  stock one apart from the highlighting.
- `read` and `write` calls are delegated to the stock renderer; error results
  render like stock; final `bash`/`powershell` results keep the styled body,
  including failures. A renderer this package does not recognize is left untouched, and an
  exception in ours falls back to stock.
- The generic renderer for tools without a result renderer mirrors the host's
  fallback; MCP tools use pi's renderers.
- The 400-line tokenizing cap applies to `bash` and `powershell` only.
- `keyHint` comes from the render context instead of a captured theme.

### Fixed

- The `bash` duration: the row's clock stops at the final result and the
  recorded duration wins.
- `grep` emphasis no longer risks catastrophic backtracking: lines over 500
  characters and backtracking-prone patterns skip it.

### Added

- Language detection for Dockerfile, Makefile, C, C++, PHP, Ruby, PowerShell,
  JSX, TSX and properties, and HTML fragments without a declaration.
- Contract tests that fail when pi changes `state.callComponent`,
  `state.startedAt` or `state.interval`.

## [0.1.2] - 2026-10-26

### Added

- `bash` and `powershell` results whose body is a recognized language are
  tokenized as one block instead of painted flat: YAML, SQL, TOML, shell,
  Python, JavaScript, TypeScript, Go, Rust, XML and HTML. Error, warning and
  `path:line:` lines keep the color they already had, and replace the
  highlighted line instead of being wrapped inside it. No theme color is derived
  or adjusted: the body is painted with the active theme's own syntax tokens.
- `detectOutputLanguage` in `detect-language.ts`: the fence detector behind a
  list of languages that show up in shell output, with higher thresholds for
  YAML and SQL. Three measured false positives set those thresholds: two
  `key: value` lines are `git log`, three `curl -I` headers pass any key count
  that ignores case, and "Update the docs in the table from last week" reads as
  SQL.

### Changed

- Detection reads the first `HIGHLIGHT_LINE_BUDGET` lines, the same lines the
  tokenizer paints, so the tail of a body past that line keeps the plain
  content color.
- README: the bash row lists the detected languages, and an existing error is
  fixed. The collapsed call keeps the last visual lines, not the opening ones.

## [0.1.1] - 2026-10-26

### Added

- `assets/icon.svg` (source) and `assets/icon.png` (1200x750, the same canvas
  `pi-simple-agents` uses) as the gallery preview. The detail thumbnail crops the
  height to 16/9, so the terminal window sits inside the central area and no edge
  of it is cut.
- `DEVELOPER.md`: module map, theme handling and cache invalidation, the rules
  the markdown transformer follows, what the hook cannot reach, and the tests.

### Changed

- Package metadata. `license: "MIT"` added: without the field npm published the
  package as Proprietary while the README claimed MIT. `description` rewritten
  for npm search, `keywords` grown from `pi-package` alone to also cover
  `pi-extension`, `syntax-highlighting`, `markdown`, `code-fences`,
  `language-detection`, `tui`, `diff` and `tool-output`, and `pi.image` points at
  the raw icon.
- README rewritten for the pi.dev audience: install first, one or two sentences
  per renderer, the limits in user terms, and links to `DEVELOPER.md` and
  `CHANGELOG.md`. The tagline now opens the file with the badges under it,
  because the gallery builds its description from the first README paragraph,
  and the `pi -e` example no longer carries an absolute path from the author's
  machine.

## [0.1.0] - 2026-10-25

### Added

- `read` result renderer: line-number gutter counted from the line the tool
  actually read, body highlighted by file language, continuation and truncation
  notices in the warning color, stock footer and collapse behavior.
- `read` and `write` call headers: path with a hyperlink, line range, compact
  header for skills and agent resource files, and a highlighted content preview
  for `write` that is capped while the argument streams.
- `edit` result renderer: diff highlighted by file language, dimmed line numbers,
  changed words in reverse video, error body in the error color. The diff fills
  the body of the call's own box, so the header keeps its success or failure
  background.
- Markdown styling for assistant messages: headings in the accent color with one
  attribute per level, inline code with its backtick delimiters restored, and
  blockquote text in the accent color. Sequences close the attribute they opened
  and never cross a line; the visible text is unchanged apart from the restored
  delimiters.
- `diff` dependency for the word-level highlight of an edited line.

### Changed

- `read` numbers its body and lifts the tool's continuation notice out of the
  highlighted text.
- `edit` no longer paints its diff through pi's `renderDiff`, which reads the
  module-global theme and does not highlight code.

### Fixed

- The highlight cache now invalidates on a theme change. The theme object is a
  proxy of stable identity, so comparing references never saw the switch; the
  cache is keyed by the color sequences the highlighter actually reads.
- Tool failures are detected through the render context. The host passes no
  `isError` inside the result, so the previous check was always false and
  `grep`, `find`, `ls` and the generic overlay never painted an error.

## [0.0.1] - 2026-10-24

### Added

- `grep` result renderer: styled paths and line numbers, matched lines
  highlighted with the file's language, match emphasized, truncation footer
  preserved.
- `find` and `ls` result renderers: dimmed directories, basenames colored by
  file family, limit footer preserved.
- `bash` and `powershell` result renderers: diffs, JSON, paths and errors
  styled, collapsed preview with the expand hint, duration line.
- Generic result overlay for `codemode`, MCP and unknown tools that have no
  renderer of their own: JSON and diff bodies highlighted, 10-line collapsed
  preview.
- Markdown fence transformer: unlabeled fences get a detected language
  injected; labeled fences and `mermaid`, `math`, `latex`, `katex` are left
  untouched.
- `read`, `write` and `edit` are passed through unchanged.
