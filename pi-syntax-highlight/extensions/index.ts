import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMarkdownTransformer } from "../src/markdown-fence-lang.ts";
import { resolveToolRenderers } from "../src/resolve-renderers.ts";

/**
 * pi-syntax-highlight entry point.
 *
 * The tool resolver wraps the host chain and overrides only the result slots
 * this package styles; the markdown transformer labels the fences that arrive
 * without a language so the built-in highlighter has a grammar to paint with.
 */
export default function piSyntaxHighlight(pi: ExtensionAPI): void {
  pi.registerToolRenderer(resolveToolRenderers);
  pi.registerMarkdownTransformer(createMarkdownTransformer());
}
