// Language detection for markdown fences that arrive without an info string, and
// for the body of a tool result (`detectOutputLanguage`, below).
//
// A fence body is a short snippet, so every heuristic here is a regular
// expression over the raw text: parsing would cost more than the wrong color it
// saves. The order of the detectors is part of the contract, because the looser
// signals (`import `, `class `, `: string`) would otherwise take snippets away
// from the stricter languages that share them.
//
// Two regex conventions run through the file: `[ \t]` where a line break must
// not count as a separator, and `\s` where the spec defines the signal that way.

// Guessing from a one-liner is a coin flip, and a wrong language colors a block
// worse than no language at all, so short input needs two non-blank lines or
// forty characters. Strong signals are conclusive on their own and bypass the
// gate: a parseable JSON document, a shebang, a diff header, an XML declaration.
const MIN_NON_BLANK_LINES = 2;
const MIN_CHARACTERS = 40;

const JSON_OPENERS = new Set(["{", "["]);

const DIFF_HEADER = /^(diff --git|--- |\+\+\+ |@@ )/;

const MARKUP_DECLARATIONS = ["<?xml", "<!DOCTYPE"];

const SHEBANG = /^#!/;

// Every interpreter here is painted by the one shell grammar, which highlight.js
// registers as `bash`; only the shebang decides which of them was meant.
const SHEBANG_INTERPRETERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/python/, "python"],
  [/\bnode\b/, "javascript"],
  [/\bruby\b/, "ruby"],
  [/\bperl\b/, "perl"],
  [/\b(?:bash|zsh|sh)\b/, "bash"],
];

const CSS_SELECTOR_BLOCK = /^[^{}\n]*?\{\s*$/gm;
const CSS_DECLARATION = /^\s*[-a-zA-Z][-\w]*\s*:\s*[^;{}\n]+;$/gm;
// Any of these means the block is a program that happens to carry braces and
// `name: value;` lines, not a stylesheet. A type annotation or an import list
// carries the same `key: value` shape as a declaration.
const CSS_FOREIGN_SIGNAL =
  /(?:=>|\bfunction\s|\bdef\s|\bconst\s|\binterface\s|\btype[ \t]+\w+[ \t]*=|\bexport\s|\bimport\s)/;

const SQL_STATEMENT_KEYWORD = /^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i;
const SQL_CLAUSE_KEYWORD = /\b(?:FROM|WHERE|VALUES|TABLE)\b/i;
const SQL_CLAUSE_KEYWORD_UPPER = /\b(?:FROM|WHERE|VALUES|TABLE)\b/g;

// Anchored to the start of a line and closed by the colon that ends a Python
// header: `public class Foo {` and `def f()` inside a patch are those other
// languages, even though they carry the bare words. A decorator is not a signal
// of its own: `@Component` and `@Override` are TypeScript and Java too.
const PYTHON_SIGNALS: readonly RegExp[] = [
  /^[ \t]*(?:async[ \t]+)?def[ \t]+\w+.*:[ \t]*$/m,
  /^[ \t]*class[ \t]+\w+.*:[ \t]*$/m,
  /^[ \t]*from[ \t]+\S+[ \t]+import[ \t]/m,
  /^[ \t]*import[ \t]+[\w.]+[ \t]*(?:,[ \t]*[\w.]+[ \t]*)*(?:as[ \t]+\w+)?$/m,
  /\bif __name__\b/,
];
// Indentation is spaces and tabs only: a `\s` here would let the line break
// before a top-level `key:` line count as one of the two indented blocks.
const PYTHON_BLOCK_LINE = /^[ \t]+\S.*:[ \t]*$/gm;

const TYPESCRIPT_SIGNALS: readonly RegExp[] = [
  /\binterface\s+\w+/,
  /^[ \t]*(?:export[ \t]+)?type[ \t]+\w+[ \t]*=/m,
  /\bimport[ \t]+type\b/,
  /:[ \t]*(?:string|number|boolean)\b/,
];

const JAVASCRIPT_SIGNALS: readonly RegExp[] = [
  /^[ \t]*(?:const|let|var|function|export|import)[ \t]/m,
  /=>/,
];

const GO_PACKAGE = /^package[ \t]+\w+[ \t]*$/m;
const GO_FUNC = /^func[ \t]/m;

// Rust needs two of these: `fn` and `use` also open single-line snippets of
// other languages, and `pub fn` is the one signal that stands alone.
const RUST_SIGNALS: readonly RegExp[] = [
  /^[ \t]*fn[ \t]+\w+/m,
  /^[ \t]*use[ \t]+[\w:]/m,
  /^[ \t]*impl\b/m,
  /\blet[ \t]+mut[ \t]/,
];
const RUST_PUBLIC_FUNC = /\bpub[ \t]+(?:async[ \t]+)?fn[ \t]+\w+/;

const CSHARP_DIRECTIVE = /^[ \t]*(?:namespace[ \t]+[\w.]+|using[ \t]+[\w.]+)/m;
const KOTLIN_FUNC = /^[ \t]*fun[ \t]+\w+/m;
const ACCESS_MODIFIER = /\b(?:public|private|protected)\b/;
const CLASS_MEMBER_KEYWORD = /\b(?:class|void|static)\b/;

const YAML_KEY = /^[A-Za-z_][\w.-]*:\s/gm;
const YAML_ITEM = /^[ \t]*-[ \t]/gm;
// A statement terminator or a brace means the block is code carrying
// `key: value` pairs, which JSON, TypeScript and C all do.
const STATEMENT_TERMINATOR = /[;{}][ \t]*$/m;

// A bare `key: value` line at the left margin. Two of them with none of the
// syntax a program needs is a YAML document; `name: string;` is a type
// annotation and `{ a: 1 }` is code, both ruled out by the pattern below.
const YAML_PLAIN_KEY = /^[A-Za-z_][\w.-]*:[ \t]*\S/gm;
const YAML_FOREIGN_SIGNAL = /[{(=]|\b(?:const|let|function)\s/;
// A key indented under another one, which is what separates a document with two
// top-level keys from two log lines that happen to carry a colon.
const YAML_INDENTED_KEY = /^[ \t]+[A-Za-z_][\w.-]*:/gm;
// A document key starts in lowercase and may carry no value at all, which is
// what a parent of a nested block looks like (`metadata:`). HTTP header names
// are Title-Case and are the reason for the case rule: `curl -I` output is not
// a document, but three of its headers satisfy any count that ignores case.
const YAML_DOCUMENT_KEY = /^[a-z_][\w.-]*:[ \t]*(?:\S.*)?$/gm;

const TOML_SECTION = /^\[[\w.-]+\][ \t]*$/m;
const TOML_KEY_VALUE = /^\w[\w.-]*[ \t]*=/gm;

const SHELL_COMMAND =
  /^(?:\$[ \t]|\w+=|export[ \t]|cd[ \t]|sudo[ \t]|git[ \t]|npm[ \t]|node[ \t]|ls[ \t]|cat[ \t]|echo[ \t]|mkdir[ \t]|rm[ \t]|cp[ \t]|mv[ \t]|make[ \t]|docker[ \t])/gm;
const SHELL_PIPELINE = /\|[ \t]*[\w./-]+/gm;
// A markdown table is a grid of pipes whose rows read like a pipeline, and its
// separator row is the one line shell output never prints.
const TABLE_ROW = /^[ \t]*\|/;
const TABLE_RULE = "|---";

// Languages worth detecting in shell output. A wrong label paints the body with
// a grammar that does not fit it, which reads worse than flat text, so a
// language enters only when it really shows up in a terminal and its detector
// is strict enough not to fire on a log. Left out for the first reason or the
// second: java, csharp and kotlin (`public`, `static`, `using`, `fun` are log
// words), css, scss and less (`key: value;` is also every environment dump),
// lua, haskell, elixir, cmake, gradle, protobuf, clojure, erlang and properties
// (no realistic shell-output scenario).
const OUTPUT_LANGUAGES: ReadonlySet<string> = new Set([
  "yaml", // kubectl, helm, compose
  "toml", // cat pyproject.toml, Cargo.toml
  "sql", // psql -f
  "bash", // environment dumps, transcripts
  "python",
  "javascript",
  "typescript",
  "go",
  "rust", // cat of source files
  "xml",
  "html", // curl
]);

type Detector = (text: string) => string | undefined;

function detectJson(text: string): string | undefined {
  return isJsonDocument(text) ? "json" : undefined;
}

function detectDiff(text: string): string | undefined {
  return DIFF_HEADER.test(firstNonBlankLine(text)) ? "diff" : undefined;
}

function detectShebang(text: string): string | undefined {
  const first = firstNonBlankLine(text);
  if (!SHEBANG.test(first)) return undefined;
  for (const [pattern, language] of SHEBANG_INTERPRETERS) {
    if (pattern.test(first)) return language;
  }
  return undefined;
}

function detectMarkup(text: string): string | undefined {
  const first = firstNonBlankLine(text);
  if (MARKUP_DECLARATIONS.some((declaration) => first.includes(declaration))) return "xml";
  return first.includes("<html") ? "html" : undefined;
}

function detectCss(text: string): string | undefined {
  if (CSS_FOREIGN_SIGNAL.test(text)) return undefined;
  if (countMatches(text, CSS_SELECTOR_BLOCK) < 2) return undefined;
  return countMatches(text, CSS_DECLARATION) >= 2 ? "css" : undefined;
}

function detectSql(text: string): string | undefined {
  const firstWord = firstNonBlankLine(text).trim().split(/\s+/)[0] ?? "";
  if (!SQL_STATEMENT_KEYWORD.test(firstWord)) return undefined;
  return SQL_CLAUSE_KEYWORD.test(text) ? "sql" : undefined;
}

// A statement terminator or a second clause in uppercase is what makes the block
// a query: prose that starts with "Update" and mentions a table and a form of
// "from" satisfies the fence detector, and its lowercase is what keeps it out of
// here. The cost is a lowercase query with no terminator, which stays flat.
function sqlSurvivesOutput(text: string): boolean {
  return text.includes(";") || countMatches(text, SQL_CLAUSE_KEYWORD_UPPER) >= 2;
}

function detectPython(text: string): string | undefined {
  if (countSignals(text, PYTHON_SIGNALS) > 0) return "python";
  return countMatches(text, PYTHON_BLOCK_LINE) >= 2 ? "python" : undefined;
}

function detectTypeScript(text: string): string | undefined {
  return hasTypeScriptSignal(text) ? "typescript" : undefined;
}

function detectJavaScript(text: string): string | undefined {
  return countSignals(text, JAVASCRIPT_SIGNALS) > 0 ? "javascript" : undefined;
}

function detectGo(text: string): string | undefined {
  return GO_PACKAGE.test(text) && GO_FUNC.test(text) ? "go" : undefined;
}

function detectRust(text: string): string | undefined {
  if (RUST_PUBLIC_FUNC.test(text)) return "rust";
  return countSignals(text, RUST_SIGNALS) >= 2 ? "rust" : undefined;
}

function detectManagedLanguage(text: string): string | undefined {
  // `using`/`namespace` and `fun` identify one language on their own; a bare
  // access modifier is shared by all three, and Java is the most common source
  // of that shape.
  if (CSHARP_DIRECTIVE.test(text)) return "csharp";
  if (KOTLIN_FUNC.test(text)) return "kotlin";
  return ACCESS_MODIFIER.test(text) && CLASS_MEMBER_KEYWORD.test(text) ? "java" : undefined;
}

function detectYaml(text: string): string | undefined {
  if (countMatches(text, YAML_KEY) + countMatches(text, YAML_ITEM) < 2) return undefined;
  return STATEMENT_TERMINATOR.test(text) ? undefined : "yaml";
}

function detectYamlKeys(text: string): string | undefined {
  if (countMatches(text, YAML_PLAIN_KEY) < 2) return undefined;
  return YAML_FOREIGN_SIGNAL.test(text) ? undefined : "yaml";
}

// Two bare `key: value` lines are as much git log and HTTP headers as they are a
// document, so the guard asks for a third key or for structure.
function yamlSurvivesOutput(text: string): boolean {
  const keys = countMatches(text, YAML_DOCUMENT_KEY);
  if (keys >= 3) return true;
  if (keys < 2) return false;
  return countMatches(text, YAML_INDENTED_KEY) > 0 || countMatches(text, YAML_ITEM) > 0;
}

function detectToml(text: string): string | undefined {
  if (!TOML_SECTION.test(text)) return undefined;
  return countMatches(text, TOML_KEY_VALUE) >= 2 ? "toml" : undefined;
}

function detectShell(text: string): string | undefined {
  if (text.includes(TABLE_RULE)) return undefined;
  const body = nonTableLines(text);
  if (countMatches(body, SHELL_COMMAND) >= 2) return "bash";
  return countMatches(body, SHELL_PIPELINE) >= 2 ? "bash" : undefined;
}

// Rows of a markdown table look like a pipeline, so they are dropped before
// either shell signal is counted.
function nonTableLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !TABLE_ROW.test(line))
    .join("\n");
}

// The first detector that recognizes the snippet wins; the list runs from the
// most to the least specific signal. No detector answers `markdown` or
// `plaintext`, which would repaint the block worse than the flat color it has.
// `go` and `rust` precede TypeScript and JavaScript because `import "fmt"` and
// `let mut` match the JavaScript signals, and their own gates are stricter.
// TypeScript precedes JavaScript for the same reason: `interface A { b: string }`
// matches both, and the annotation is the more specific answer.
// Bare `key: value` lines precede TypeScript too, because `name: string` is a
// YAML entry as much as it is a type annotation; the one without braces and
// assignments is the YAML document.
const DETECTORS: readonly Detector[] = [
  detectJson,
  detectDiff,
  detectShebang,
  detectMarkup,
  detectCss,
  detectSql,
  detectPython,
  detectGo,
  detectRust,
  detectYamlKeys,
  detectTypeScript,
  detectJavaScript,
  detectManagedLanguage,
  detectYaml,
  detectToml,
  detectShell,
];

export function detectLanguage(text: string): string | undefined {
  const lines = nonBlankLines(text);
  if (!hasStrongSignal(text, lines) && lines.length < MIN_NON_BLANK_LINES && text.trim().length < MIN_CHARACTERS) {
    return undefined;
  }
  for (const detect of DETECTORS) {
    const language = detect(text);
    if (language !== undefined) return language;
  }
  return undefined;
}

// The language of a tool-output body, or undefined when the body should keep its
// per-line styling. Shell output is log-shaped far more often than code-shaped,
// so this is `detectLanguage` plus two guard rails: the allowlist above, and the
// higher thresholds the two loosest detectors need to survive a log.
export function detectOutputLanguage(text: string): string | undefined {
  const language = detectLanguage(text);
  if (language === undefined) return undefined;
  // The caller checks these two shapes over the whole body, so a sample that
  // parses as JSON is a prefix of it, not the document.
  if (language === "json" || language === "diff") return undefined;
  if (!OUTPUT_LANGUAGES.has(language)) return undefined;
  if (language === "yaml") return yamlSurvivesOutput(text) ? language : undefined;
  if (language === "sql") return sqlSurvivesOutput(text) ? language : undefined;
  return language;
}

function nonBlankLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function firstNonBlankLine(text: string): string {
  return nonBlankLines(text)[0] ?? "";
}

function isJsonDocument(text: string): boolean {
  if (!JSON_OPENERS.has(text.trimStart().charAt(0))) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function hasStrongSignal(text: string, lines: readonly string[]): boolean {
  if (isJsonDocument(text)) return true;
  const first = lines[0] ?? "";
  if (first.startsWith("#!")) return true;
  if (first.startsWith("diff --git")) return true;
  return MARKUP_DECLARATIONS.some((declaration) => first.includes(declaration));
}

// Every pattern passed here carries the global flag, so `match` returns all the
// hits instead of the first one.
function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function countSignals(text: string, signals: readonly RegExp[]): number {
  return signals.filter((signal) => signal.test(text)).length;
}

function hasTypeScriptSignal(text: string): boolean {
  return countSignals(text, TYPESCRIPT_SIGNALS) > 0;
}
