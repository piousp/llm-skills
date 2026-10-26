import type { ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";

// Renderers receive the host's `Theme`; they only need these three members, so
// the structural subset keeps every module testable without constructing one.
export interface StyleTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: ThemeBg, text: string): string;
  bold(text: string): string;
}

// The subset the markdown pass needs. `fg()` wraps a whole string in the color
// and closes it at the end, which cannot recolor a span inside a line the host
// already painted: that pass has to build the escape sequence itself and close
// it at an exact position. Declared apart from `StyleTheme` for the same reason
// that one exists: a module only asks for the members it reads.
export interface AnsiTheme {
  getFgAnsi(color: ThemeColor): string;
  getBgAnsi(color: ThemeBg): string;
}

// Colors named by the role they play in tool output, so retheming the package
// is one edit here instead of a hunt through every renderer.
export interface SyntaxTokens {
  path: ThemeColor;
  dirPath: ThemeColor;
  lineNumber: ThemeColor;
  context: ThemeColor;
  content: ThemeColor;
  // A body printed flat, with no syntax pass: the host paints those with
  // `toolOutput`, which is not the `text` the rest of the bodies use.
  plain: ThemeColor;
  notice: ThemeColor;
  empty: ThemeColor;
  broken: ThemeColor;
}

export const TOKEN = {
  path: "accent",
  dirPath: "muted",
  lineNumber: "syntaxNumber",
  context: "dim",
  content: "text",
  plain: "toolOutput",
  notice: "warning",
  empty: "dim",
  broken: "error",
} as const satisfies SyntaxTokens;

// The markdown tokens this package paints itself. The host's markdown theme is
// not extensible, so the tokens whose color the pass can reach are named here
// instead of being read from a theme entry the host decides.
export const MD_TOKEN = { quote: "accent" } as const satisfies { quote: ThemeColor };

// `Theme.bold()` wraps a whole string in both codes, which cannot emphasize a
// span inside an already rendered line: emphasis needs each marker on its own.
export const BOLD_ON = "\x1b[1m";
export const BOLD_OFF = "\x1b[22m";

// The same constraint for the attributes the markdown pass injects: each marker
// travels alone and closes only what it opened, so the host's style survives the
// span. No `\x1b[0m` reset is ever emitted, because it would drop that style too.
export const ITALIC_ON = "\x1b[3m";
export const ITALIC_OFF = "\x1b[23m";
export const UNDERLINE_ON = "\x1b[4m";
export const UNDERLINE_OFF = "\x1b[24m";
export const INVERSE_ON = "\x1b[7m";
export const INVERSE_OFF = "\x1b[27m";
export const FG_DEFAULT = "\x1b[39m";
export const BG_DEFAULT = "\x1b[49m";
// `\x1b[22m` closes both bold and dim, which is why `BOLD_OFF` and `DIM_OFF`
// share the sequence and why the only place dim is re-opened is a span that
// knows the host left it off.
export const DIM_ON = "\x1b[2m";
export const DIM_OFF = "\x1b[22m";

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "go", "rs", "py", "rb", "php", "java", "kt", "kts", "swift",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "scala", "lua", "pl", "pm",
  "ex", "exs", "erl", "hs", "zig", "dart", "sql", "graphql", "gql",
]);

const CONFIG_EXTENSIONS = new Set(["json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "env"]);

const DOC_EXTENSIONS = new Set(["md", "mdx", "txt", "rst"]);

const SHELL_EXTENSIONS = new Set(["sh", "bash", "zsh", "fish", "ksh", "ps1"]);

const WEB_EXTENSIONS = new Set(["css", "scss", "less", "html", "htm", "vue", "svelte"]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"]);

const BUILD_FILE_NAMES = new Set(["Makefile", "makefile", "GNUmakefile", "Dockerfile", "dockerfile"]);

// One implementation for every caller, so `".gitignore"` cannot be an extension
// in one module and a dotfile in another.
export function splitExtension(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

export function fileTypeToken(fileName: string): ThemeColor {
  if (BUILD_FILE_NAMES.has(fileName)) return "syntaxFunction";
  const extension = splitExtension(fileName);
  if (extension === undefined) return "toolOutput";
  if (extension === "mk") return "syntaxFunction";
  if (CODE_EXTENSIONS.has(extension)) return "syntaxType";
  if (CONFIG_EXTENSIONS.has(extension)) return "syntaxString";
  if (DOC_EXTENSIONS.has(extension)) return "toolOutput";
  if (SHELL_EXTENSIONS.has(extension)) return "syntaxKeyword";
  if (WEB_EXTENSIONS.has(extension)) return "syntaxFunction";
  if (IMAGE_EXTENSIONS.has(extension)) return "syntaxNumber";
  return "toolOutput";
}
