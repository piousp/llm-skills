import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeTheme, captureTheme } from "../src/active-theme.ts";
import { createMarkdownTransformer } from "../src/markdown-fence-lang.ts";
import { resolveToolRenderers } from "../src/resolve-renderers.ts";

/**
 * pi-syntax-highlight entry point.
 *
 * The tool resolver wraps the host chain and overrides only the result slots
 * this package styles; the markdown transformer labels the fences that arrive
 * without a language so the built-in highlighter has a grammar to paint with, and
 * styles headings, blockquotes and inline code spans for the assistant message.
 */
export default function piSyntaxHighlight(pi: ExtensionAPI): void {
  pi.registerToolRenderer(resolveToolRenderers);
  pi.registerMarkdownTransformer(createMarkdownTransformer({ resolveTheme: activeTheme }));
  // A render slot receives the theme it paints with, but a markdown message does
  // not: `session_start` is the one place the extension is handed one, and the
  // reference it captures keeps resolving against the theme in effect, so no later
  // session event is needed.
  pi.on("session_start", (_event, ctx) => captureTheme(ctx.ui.theme));
}
