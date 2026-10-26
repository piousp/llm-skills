import type { Theme } from "@earendil-works/pi-coding-agent";

// The `Theme` a renderer receives is a proxy of stable identity whose reads
// resolve against the theme in effect, so a theme change never swaps the object.
// Keeping the reference is therefore correct, and anything derived from it (a
// palette, a cached style, a highlight line) has to be invalidated by value:
// comparing the reference would never see the change.
let active: Theme | undefined;

// Called by every render slot this package owns, before anything is painted, so
// the last frame rendered is what the non-renderer paths see afterwards.
export function captureTheme(theme: Theme): void {
  active = theme;
}

// `undefined` until the first result of a session paints, and again after
// `resetActiveTheme`; callers degrade to unstyled output instead of throwing.
export function activeTheme(): Theme | undefined {
  return active;
}

// Tests only: the capture is module state on purpose, and each test starts from
// the same "no theme seen yet" state instead of inheriting the previous one.
export function resetActiveTheme(): void {
  active = undefined;
}
