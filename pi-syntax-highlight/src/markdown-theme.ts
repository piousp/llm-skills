import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { type AnsiTheme, DIM_OFF, DIM_ON, FG_DEFAULT, MD_TOKEN } from "./tokens.ts";

// The heading foreground. One token for all six levels on purpose: the level is
// told apart by an SGR attribute in `markdown-style.ts`, so retheming cannot make
// two levels of the same document drift into two unrelated colors.
const ACCENT_TOKEN: ThemeColor = "accent";

// The few sequences the markdown pass injects, derived from the theme once per
// render. The host's markdown theme is not extensible, so this is the palette the
// pass paints with instead of `fg()`, which wraps a whole string and therefore
// cannot recolor a span inside a line the host already painted.
export interface MarkdownPalette {
  // What every heading opens with; "" when the theme gives the token no color of
  // its own, which is the signal to inject nothing at all.
  accent: string;
  // The quote pair has to undo what the host paints itself: `mdQuote` may be
  // faint, so opening the quote turns that off first and closing restores it.
  quoteOpen: string;
  quoteClose: string;
  // Value key of the transformer memo, derived from the sequences above and
  // nothing else: a theme switch that does not move them leaves the previous
  // render valid, which is exactly right because the bytes would be identical.
  signature: string;
}

export function markdownPalette(theme: AnsiTheme): MarkdownPalette {
  const accent = ownFg(theme, ACCENT_TOKEN);
  // The host paints blockquote text through `mdQuote`, and its faint flag is what
  // `\x1b[22m` closes. That is also the one sequence of the pass that closes bold
  // along with dim, which is safe only here: the host applies no bold to quote text.
  const quoteIsDim = theme.getFgAnsi("mdQuote").includes(DIM_ON);
  const quoteFg = ownFg(theme, MD_TOKEN.quote);
  // Without a color of its own the construct has nothing to say, so the pair stays
  // empty rather than cancelling and re-applying the host's own style.
  const quoteOpen = quoteFg === "" ? "" : (quoteIsDim ? DIM_OFF : "") + quoteFg;
  const quoteClose = quoteFg === "" ? "" : FG_DEFAULT + (quoteIsDim ? DIM_ON : "");
  return {
    accent,
    quoteOpen,
    quoteClose,
    signature: [accent, quoteOpen, quoteClose].join("\u0000"),
  };
}

// A token the theme maps to the terminal default ("" or `\x1b[39m` in the host's
// `Theme`) is not a color this pass can add: injecting it would wrap the text in
// sequences that only cancel each other, which is precisely what a monochrome
// terminal must not receive.
function ownFg(theme: AnsiTheme, token: ThemeColor): string {
  const ansi = theme.getFgAnsi(token);
  return ansi === "" || ansi === FG_DEFAULT ? "" : ansi;
}
