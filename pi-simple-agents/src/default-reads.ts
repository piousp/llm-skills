import fs from "node:fs";
import path from "node:path";

export interface ResolvedDefaultReads {
  files: Array<{ path: string; content: string }>;
  warnings: string[];
}

function resolveEntryPath(entry: string, cwd: string, homeDir: string): string {
  if (entry === "~") {
    return homeDir;
  }
  if (entry.startsWith("~/")) {
    return path.join(homeDir, entry.slice(2));
  }
  if (path.isAbsolute(entry)) {
    return entry;
  }
  return path.resolve(cwd, entry);
}

type SafeReadResult = { ok: true; content: string } | { ok: false; reason: string };

function readRegularFile(resolvedPath: string): SafeReadResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return { ok: false, reason: "could not be read" };
  }

  if (!stat.isFile()) {
    return { ok: false, reason: "is not a regular file" };
  }

  try {
    return { ok: true, content: fs.readFileSync(resolvedPath, "utf8") };
  } catch {
    return { ok: false, reason: "could not be read" };
  }
}

export function resolveDefaultReads(
  defaultReads: readonly string[],
  cwd: string,
  homeDir: string,
): ResolvedDefaultReads {
  const files: Array<{ path: string; content: string }> = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();

  for (const rawEntry of defaultReads) {
    const resolvedPath = resolveEntryPath(rawEntry, cwd, homeDir);

    if (seenPaths.has(resolvedPath)) {
      continue;
    }
    seenPaths.add(resolvedPath);

    const result = readRegularFile(resolvedPath);
    if (!result.ok) {
      warnings.push(`defaultReads entry "${rawEntry}" (resolved: ${resolvedPath}) ${result.reason}.`);
      continue;
    }

    files.push({ path: resolvedPath, content: result.content });
  }

  return { files, warnings };
}
