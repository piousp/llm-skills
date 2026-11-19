# pi-syntax-highlight

Syntax highlighting for what pi prints: tool output, and code fences the assistant writes without a language. Rendering only: tool calls, results and settings stay exactly as they are.

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

Needs pi 1.5.1 or newer. Node 24 or newer matters only for running the working copy, not for the install.

## What gets colored

| Tool | What you see |
|---|---|
| `grep` | Paths and line numbers styled, each matched line highlighted in the language of its file, the match itself emphasized. The truncation footer stays. |
| `find`, `ls` | Directories dimmed with a trailing slash, basenames colored by file family. The limit footer stays. |
| `bash`, `powershell` | Finished output styled: diffs, JSON, paths, errors, and a body in a recognized language (YAML, SQL, TOML, shell, Python, JavaScript, TypeScript, JSX, TSX, Go, Rust, Java, Kotlin, Scala, Groovy, Lua, C, C++, PHP, Ruby, PowerShell, Dockerfile, Makefile, CSS, SCSS, Less, XML, HTML). Error, warning and `path:line:` lines keep their own color inside a highlighted body. A collapsed call shows its last lines, the expand hint, and the duration. Only the first 400 lines are tokenized. |
| `read` | The expanded body is highlighted by file language. No line numbers, and a collapsed read stays silent, as in stock pi. The call header, errors and image results are stock. |
| `edit` | The successful diff is highlighted by file language, line numbers dimmed, changed words in reverse video. A failure is drawn by stock pi. |
| `write` | Stock pi. |
| Extension tools with no result renderer | JSON and diff bodies get highlighted, anything else keeps the plain content color, and the body collapses to 10 lines with the expand hint, as the host's own fallback does. |
| MCP tools and tools that bring their own renderer | Left to pi's renderers. |
| Markdown fences | A closed fence with no label gets a detected language, so the block comes out colored. A fence that already carries a label is never rewritten, and `mermaid`, `math`, `latex` and `katex` are left alone. Applies to assistant messages, thinking blocks, custom messages and summaries. |

Nothing else in the markdown is restyled.

`read`, `grep` and `edit` take the language of a file from pi's extension table and, when it answers nothing, from a table of their own: `.groovy`, `.gvy`, `.gradle`, `.kts`, `.pl`, `.pm`, `.mk`, `.nix` and `.dart` are highlighted even though the host does not know them.

## Limits

- Fences inside lists and blockquotes are not labeled.
- A fence that is still streaming (not closed yet) is not labeled.
- A `grep` output whose own path contains `:N: ` is ambiguous, and pi does not disambiguate it either.
- Match emphasis in `grep` is skipped for lines longer than 500 characters and for patterns prone to catastrophic backtracking; the line is still shown.
- A bash body is identified and tokenized from its first 400 lines. A language that only appears after that line leaves the body flat. The 400-line limit applies to `bash` and `powershell` only.
- Java-style `.properties` content is detected only inside fences, not in bash output.
- HTML fragments are recognized by a list of known tags plus a closing tag; unknown tags stay flat. JSX without `className` or `={` can be detected as HTML.
- A tool whose result renderer this package does not recognize keeps its own look.
- `.sass` stays flat: highlight.js ships no `sass` grammar, although pi's extension table answers `sass` for it.
- pi registers about 21 grammars at startup and loads the rest in the background: a body in a grammar outside that first set can stay flat on the first render of a session and be colored on the next.
- An anonymous `companion object { … }` reads as Java: the Kotlin signal asks for a name after `object`.
- `sealed class X` reads as Java, since Java 17 and Kotlin share the form; `enum class X` reads as Kotlin.
- A Scala source that declares only `val x = …`, with no `object … extends`, `case class` or `def …: T =`, reads as Kotlin.
- No initialized theme, no color: the renderers fall back to plain tool output.

## Development

```bash
npm install
npm run typecheck
npm test
```

Load the working copy from the package directory with `pi -e .`.

## More

- [DEVELOPER.md](DEVELOPER.md): how the renderers and the fence labeler are built, and the tests.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.

## License

MIT
