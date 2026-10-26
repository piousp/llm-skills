import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { TOKEN, type StyleTheme } from "./tokens.ts";

// The path display the built-in tool headers share. The host does not export
// `renderToolPath`, `shortenPath` or `linkPath`, so a header of this package has
// to reproduce them from the primitives it does export (`hyperlink`, the
// terminal capabilities and the two colors below). Everything here is display:
// the text is shortened for the eye while the link still targets the absolute
// path, so a click opens the file the tool actually read.

// Only the home directory is shortened. The built-in never makes the path
// relative to the cwd, so a file outside the home directory keeps its full path.
export function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// The target of the link: the argument as the tool itself resolves it, with `~`
// expanded and a relative path anchored at the cwd. A path that is already
// absolute passes through `resolve` untouched.
export function absolutePath(rawPath: string, cwd: string | undefined): string {
  const expanded = rawPath === "~" || rawPath.startsWith("~/") ? `${homedir()}${rawPath.slice(1)}` : rawPath;
  return resolve(cwd ?? process.cwd(), expanded);
}

// OSC 8, gated on the terminal capability exactly like the built-in, so a
// terminal without hyperlink support shows the styled text alone.
export function linkPath(styledText: string, rawPath: string, cwd: string | undefined): string {
  if (!getCapabilities().hyperlinks) return styledText;
  return hyperlink(styledText, pathToFileURL(absolutePath(rawPath, cwd)).href);
}

// An empty path is the argument that has not arrived yet, which the built-in
// renders as a placeholder instead of an empty slot.
export function renderToolPath(rawPath: string, theme: StyleTheme, cwd: string | undefined): string {
  if (rawPath === "") return theme.fg(TOKEN.plain, "...");
  return linkPath(theme.fg(TOKEN.path, shortenPath(rawPath)), rawPath, cwd);
}

// The one cwd-relative form the built-in shows: a path inside the cwd becomes
// relative, anything else stays absolute, and the separators are made posix so
// the label reads the same on every platform.
export function relativeToCwdOrAbsolute(filePath: string, cwd: string | undefined): string {
  const base = resolve(cwd ?? process.cwd());
  const absolute = resolve(filePath);
  const relativePath = relative(base, absolute);
  const inside =
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  return (inside ? relativePath || "." : absolute).split(sep).join("/");
}
