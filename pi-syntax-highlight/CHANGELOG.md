# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog, and this project uses semantic versioning.

## [0.2.1] - 2026-11-16

### Added

- Manual GitHub Actions workflow to publish to npm.
- MIT `LICENSE` file.

### Changed

- Only runtime files are published (43 → 22 files).

### Fixed

- Stack traces and email headers are no longer detected as `makefile`. Targets starting with a capital letter (e.g. `Main:`) are no longer detected either.
- Code fences in user messages get their language label again.

## [0.2.0] - 2026-11-16

### Added

- Language detection for Dockerfile, Makefile, C, C++, PHP, Ruby, PowerShell, JSX, TSX, properties and HTML fragments.
- Tests that fail if pi changes the internals this package relies on.

### Changed

- Requires pi 1.5.1 or newer.
- `read`, `write` and error results now use the stock pi renderers. Final `bash`/`powershell` results keep the styled body, even on failure.
- Fence labels also apply to thinking, custom and summary messages.
- Colors follow stock pi.
- The 400-line highlight limit applies to `bash` and `powershell` only.
- MCP tools use pi's own renderers.

### Removed

- Markdown styling of assistant messages. Only unlabeled fences get a label now.
- The `read` line-number gutter and the `write` content overlay.
- Fence info strings are copied as written, so `{.ts}` and `js title="a"` are no longer cleaned up.

### Fixed

- `bash` duration stops at the final result.
- `grep` no longer hangs on lines over 500 characters or risky patterns.

## [0.1.2] - 2026-10-26

### Added

- `bash` and `powershell` output in a known language (YAML, SQL, TOML, shell, Python, JS, TS, Go, Rust, XML, HTML) is highlighted as one block.

### Changed

- Detection reads the same lines the highlighter paints.
- README lists the detected languages and fixes the collapsed-call description.

## [0.1.1] - 2026-10-26

### Added

- Package icon for the gallery.
- `DEVELOPER.md` with the module map and design notes.

### Changed

- Added `license: "MIT"`; npm was listing the package as Proprietary.
- Better npm description and keywords.
- README rewritten for pi.dev readers.

## [0.1.0] - 2026-10-25

### Added

- `read` results with line numbers and highlighting by file language.
- `read` and `write` headers with a path link and line range, plus a highlighted preview for `write`.
- `edit` results with a highlighted diff and word-level changes.
- Markdown styling for assistant messages: headings, inline code and blockquotes.

### Changed

- `read` numbers its body and keeps the continuation notice out of the highlighted text.
- `edit` no longer uses pi's `renderDiff`.

### Fixed

- The highlight cache now refreshes when the theme changes.
- Tool errors are detected correctly, so `grep`, `find`, `ls` and generic results show them.

## [0.0.1] - 2026-10-24

### Added

- `grep` results with styled paths, line numbers and highlighted matches.
- `find` and `ls` results with dimmed directories and colored file names.
- `bash` and `powershell` results with styled diffs, JSON, paths and errors.
- Generic renderer for `codemode`, MCP and unknown tools.
- Markdown fences without a label get a detected language.
- `read`, `write` and `edit` pass through unchanged.
