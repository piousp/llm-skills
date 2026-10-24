import { fileTypeToken, TOKEN, type StyleTheme } from "./tokens.ts";

export type PathLine =
  | { kind: "dir"; path: string }
  | { kind: "file"; path: string }
  | { kind: "notice"; text: string }
  | { kind: "plain"; text: string };

const PLAIN_SENTINELS = new Set([
  "No matches found",
  "No files found matching pattern",
  "(empty directory)",
]);

// `find` and `ls` append their limit block as one bracketed line, and stock pi
// counts it as a body line, so it is classified apart from a plain one.
const NOTICE_LINE = /^\[.*\]$/;

export function classifyPathLine(line: string): PathLine {
  if (NOTICE_LINE.test(line)) return { kind: "notice", text: line };
  if (PLAIN_SENTINELS.has(line) || line.trim() === "") return { kind: "plain", text: line };
  return line.endsWith("/") ? { kind: "dir", path: line } : { kind: "file", path: line };
}

// Directories keep the dim path color; only the entry named last gets a type
// color, which is what makes a nested path readable at a glance. That name is
// also bold, the one weight the terminal keeps when two theme colors land close
// together.
export function stylePath(path: string, theme: StyleTheme): string {
  if (path === "") return "";
  const segments = path.split("/");
  const lastIndex = segments.length - 1;
  const isDirectory = path.endsWith("/");
  // The closing slash of a directory leaves a trailing empty segment, so the
  // name to color is the last non-empty one.
  const lastNameIndex = segments.reduce((acc, segment, index) => (segment === "" ? acc : index), -1);
  const styled = segments.map((segment, index) => {
    const slash = index < lastIndex ? "/" : "";
    if (index === lastNameIndex) {
      const color = isDirectory ? "dim" : fileTypeToken(segment);
      return `${theme.bold(theme.fg(color, segment))}${slash}`;
    }
    // An empty segment is the leading slash of an absolute path.
    if (segment === "") return slash;
    return `${theme.fg(TOKEN.dirPath, segment)}${slash}`;
  });
  return styled.join("");
}
