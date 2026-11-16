import { getMarkdownTheme, highlightCode, type ThemeColor } from "@earendil-works/pi-coding-agent";

export type HighlightFn = (code: string, lang: string) => string[];

// One batched pass over a huge blob is the slowest step of a render. Only the
// shell, whose output is unbounded, passes it as a `highlightLines` budget: past
// this many lines the tail is painted with the caller's plain fallback.
export const HIGHLIGHT_LINE_BUDGET = 400;

const CACHE_LIMIT = 64;
// `highlightCode` paints through the module-global theme and this cache is keyed
// by language and code only, so the cached lines go stale as soon as the theme
// changes: `syncHighlightTheme` is what drops them, and every renderer calls it
// with the theme it is about to paint with.
const cache = new Map<string, string[]>();

// The tokens `highlightCode` paints with. Reading their sequences is the only
// observable the theme offers that changes when the user switches themes.
const SYNC_TOKENS = [
  "syntaxKeyword",
  "syntaxString",
  "syntaxNumber",
  "syntaxComment",
  "syntaxFunction",
  "syntaxType",
  "syntaxVariable",
  "syntaxPunctuation",
  "syntaxOperator",
  "toolDiffAdded",
  "toolDiffRemoved",
  "mdCodeBlock",
  "text",
  "muted",
] as const satisfies readonly ThemeColor[];

let syncedTheme: unknown;
let syncedSignature: string | undefined;
let syncedThemeSet = false;

// The theme a renderer receives is a proxy of stable identity, so comparing
// references would never invalidate: the signature is the concatenation of the
// sequences the highlighter paints with, which is what actually changes. It stays
// a value comparison on purpose; a theme whose colors did not move leaves the
// cache alone, which is every frame of a normal session.
// Themes without `getFgAnsi` (the fakes in tests) and themes that throw before
// initialization fall back to the identity comparison the module started with.
function themeSignature(theme: unknown): string | undefined {
  if (typeof theme !== "object" || theme === null) return undefined;
  const getFgAnsi = (theme as { getFgAnsi?: unknown }).getFgAnsi;
  if (typeof getFgAnsi !== "function") return undefined;
  const read = getFgAnsi as (this: unknown, color: ThemeColor) => unknown;
  try {
    return SYNC_TOKENS.map((token) => String(read.call(theme, token))).join("\u0000");
  } catch {
    return undefined;
  }
}

// The first call only registers the theme; a later call with a different value
// means the module-global theme changed, and every cached line is stale.
export function syncHighlightTheme(theme: unknown): void {
  const signature = themeSignature(theme);
  if (syncedThemeSet) {
    const unchanged =
      signature !== undefined ? signature === syncedSignature : theme === syncedTheme;
    if (unchanged) return;
    cache.clear();
  }
  syncedTheme = theme;
  syncedSignature = signature;
  syncedThemeSet = true;
}

// `highlightCode` paints with the code-block color when it has no grammar for the
// language, which is also what a grammar that has not loaded yet looks like.
// Such a result carries no syntax, so it is neither cached nor trusted.
function isCodeBlockPaint(code: string, lines: readonly string[]): boolean {
  try {
    const input = code.split("\n");
    const { codeBlock } = getMarkdownTheme();
    return lines.length === input.length && input.every((line, index) => lines[index] === codeBlock(line));
  } catch {
    return false;
  }
}

export const highlight: HighlightFn = (code, lang) => {
  const key = `${lang}\u0000${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    // Re-inserting moves the entry to the back, so the front is the least recently used.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const lines = highlightCode(code, lang);
  if (isCodeBlockPaint(code, lines)) return lines;
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, lines);
  return lines;
};

export function clearHighlightCache(): void {
  cache.clear();
}

// `highlightFn` is injected by every caller: in tests because `highlightCode`
// would read the module-global theme and throw before any theme is initialized,
// and in production because the resolver passes the cached `highlight`.
export function highlightLines(
  code: string,
  lang: string,
  fallback: (line: string) => string,
  highlightFn: HighlightFn,
  budget = Infinity,
): string[] {
  const lines = code.split("\n");
  const headCount = Math.min(lines.length, budget);
  const head = lines.slice(0, headCount);
  let highlighted: string[] = [];
  try {
    highlighted = highlightFn(head.join("\n"), lang);
    // No syntax in the result: the caller's flat color is the honest paint.
    if (isCodeBlockPaint(head.join("\n"), highlighted)) highlighted = [];
  } catch {
    highlighted = [];
  }
  // `highlighted` is the source of truth only where it has a line for the same
  // index; anything shorter falls back so the result always matches the input.
  const headLines = head.map((line, index) => highlighted[index] ?? fallback(line));
  return [...headLines, ...lines.slice(headCount).map(fallback)];
}
