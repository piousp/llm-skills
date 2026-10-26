# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog, and this project uses semantic versioning.

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
