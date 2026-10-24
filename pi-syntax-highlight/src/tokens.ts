import type { ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";

// Renderers receive the host's `Theme`; they only need these three members, so
// the structural subset keeps every module testable without constructing one.
export interface StyleTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: ThemeBg, text: string): string;
  bold(text: string): string;
}

// Colors named by the role they play in tool output, so retheming the package
// is one edit here instead of a hunt through every renderer.
export interface SyntaxTokens {
  path: ThemeColor;
  dirPath: ThemeColor;
  lineNumber: ThemeColor;
  context: ThemeColor;
  content: ThemeColor;
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
  notice: "warning",
  empty: "dim",
  broken: "error",
} as const satisfies SyntaxTokens;

// `Theme.bold()` wraps a whole string in both codes, which cannot emphasize a
// span inside an already rendered line: emphasis needs each marker on its own.
export const BOLD_ON = "\x1b[1m";
export const BOLD_OFF = "\x1b[22m";

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
