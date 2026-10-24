# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog, and this project uses semantic versioning.

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
