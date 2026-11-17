import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../hash.ts";
import { OBSERVE_CURSOR_FILE } from "../names.ts";
import { stateDir } from "../write-base.ts";
import { ensurePrivateDir, writePrivateFile } from "../writer.ts";
import { isMissingPathError, isPlainObject } from "../values.ts";
import { MIN_IDLE_MS } from "./types.ts";
import type { CursorEntry, ObserveCursor, SessionFileRef } from "./types.ts";

// state/observe-cursor.json: which session files the observer has read, keyed by the id of their header. It only decides
// whether a file is read again; it is never the source of what was observed. A file that is read twice yields the same
// episodes and observations, because their ids are deterministic and the fold dedupes by id, so a cursor that is lost,
// damaged or behind costs a re-read and nothing else.

export function emptyCursor(): ObserveCursor {
  return { files: {} };
}

function cursorPath(base: string): string {
  return path.join(stateDir(path.resolve(base)), OBSERVE_CURSOR_FILE);
}

function isCursorEntry(value: unknown): value is CursorEntry {
  return (
    isPlainObject(value) &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.mtimeMs === "number" &&
    typeof value.firstLineHash === "string"
  );
}

// An absent cursor is the first scan. A cursor nobody can read -- not JSON, not an object, a damaged entry -- is an empty
// one, for the reason above: what it was ahead of is read again.
export async function readCursor(base: string): Promise<ObserveCursor> {
  let text: string;
  try {
    text = await fs.promises.readFile(cursorPath(base), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return emptyCursor();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyCursor();
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.files)) return emptyCursor();

  const files: Record<string, CursorEntry> = {};
  for (const [headerId, entry] of Object.entries(parsed.files)) {
    if (isCursorEntry(entry)) files[headerId] = entry;
  }
  return { files };
}

export async function writeCursor(base: string, cursor: ObserveCursor): Promise<void> {
  const root = stateDir(base);
  ensurePrivateDir(root, base);
  await writePrivateFile(path.join(root, OBSERVE_CURSOR_FILE), `${JSON.stringify(cursor, null, 2)}\n`, root);
}

// The hash of the first line of a session file (its header), kept in the entry so a later version can tell a file that was
// replaced from one that grew.
export function cursorEntryOf(file: SessionFileRef, firstLine: string): CursorEntry {
  return { path: file.path, size: file.size, mtimeMs: file.mtimeMs, firstLineHash: sha256Hex(firstLine) };
}

export type SkipReason = "current" | "recent" | "unchanged";

export interface ScanPlan {
  read: SessionFileRef[];
  skipped: { file: SessionFileRef; reason: SkipReason }[];
}

export interface ScanPlanOptions {
  now: Date;
  currentSessionFile: string | null;
  minIdleMs?: number;
}

// Which files to read now. Never the session in progress, and never a file touched less than `minIdleMs` ago: it may still
// be written, and it is looked at on a later start. Of the rest, a file is read when the cursor has no entry for its
// header, or the entry is of another path, size or modification time. A rewrite -- the size shrank, a file replaced under
// the same header -- is one of those, so it is reparsed in full, which is also how a file that merely grew is read: the
// cursor holds no offset, because the reader always parses up to the last newline and the fold dedupes what it saw before.
export function planScan(files: readonly SessionFileRef[], cursor: ObserveCursor, options: ScanPlanOptions): ScanPlan {
  const minIdleMs = options.minIdleMs ?? MIN_IDLE_MS;
  const current = options.currentSessionFile === null ? null : path.resolve(options.currentSessionFile);
  const plan: ScanPlan = { read: [], skipped: [] };

  for (const file of files) {
    if (current !== null && path.resolve(file.path) === current) {
      plan.skipped.push({ file, reason: "current" });
      continue;
    }
    if (options.now.getTime() - file.mtimeMs < minIdleMs) {
      plan.skipped.push({ file, reason: "recent" });
      continue;
    }

    const seen = cursor.files[file.headerId];
    const unchanged = seen !== undefined && seen.path === file.path && seen.size === file.size && seen.mtimeMs === file.mtimeMs;
    if (unchanged) plan.skipped.push({ file, reason: "unchanged" });
    else plan.read.push(file);
  }

  return plan;
}
