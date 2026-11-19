import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { splitExtension } from "./tokens.ts";

// The host resolves a language from the extension alone, and its table predates
// grammars that pi already loads: `.groovy`, `.kts`, `.pl`, `.mk`, `.nix` and
// `.dart` all read as flat text. The gaps are filled here, next to the one
// resolver the renderers call, instead of at each of the three call sites.
// `ReadonlyMap` is the freeze a `Map` can carry: `Object.freeze` does not stop
// `set`, and the table is data, so a stray write would change every later answer.
const GAP_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ["groovy", "groovy"],
  ["gvy", "groovy"],
  ["gradle", "groovy"],
  ["kts", "kotlin"],
  ["pl", "perl"],
  ["pm", "perl"],
  ["mk", "makefile"],
  ["nix", "nix"],
  ["dart", "dart"],
]);

// The host answer wins whenever it exists, so this module only adds to what pi
// already paints and never repaints a file the host knows.
export function languageForPath(path: string): string | undefined {
  const fromHost = getLanguageFromPath(path);
  if (fromHost !== undefined) return fromHost;
  const extension = splitExtension(path);
  return extension === undefined ? undefined : GAP_LANGUAGES.get(extension);
}
