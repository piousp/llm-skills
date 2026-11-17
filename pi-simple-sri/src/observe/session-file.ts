import fs from "node:fs";
import path from "node:path";
import { migrateSessionEntries, parseSessionEntries, type FileEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type { Result } from "../types.ts";
import { isMissingPathError, readBytes, toErrorMessage } from "../values.ts";
import type { SessionFileRef, SessionRead, SessionsRoot } from "./types.ts";

// Reading the session files pi wrote under <agentDir>/sessions. Read only: the observer never writes there.
//
// pi groups sessions by project (`<root>/--<cwd>--/<timestamp>_<id>.jsonl`) unless the session directory is
// overridden, which gives the flat layout (`<root>/<timestamp>_<id>.jsonl`). Only files at that depth are top-level
// sessions: the `run-*` directories of subagents sit one level deeper and are excluded by construction.

const GROUPED_DIR = /^--.*--$/;
const SESSION_EXTENSION = ".jsonl";
const NEWLINE = 0x0a;
// A header line is a few hundred bytes; a first line longer than this is not a session header.
const HEADER_READ_BYTES = 16 * 1024;
const ALWAYS_EXCLUDED_DIRS = ["/tmp", "/private/tmp"];

// `sessionDir` is what ctx.sessionManager.getSessionDir() answers: the project directory when grouped, the root
// itself when flat.
export function sessionsRootOf(sessionDir: string): SessionsRoot {
  const dir = path.resolve(sessionDir);
  return GROUPED_DIR.test(path.basename(dir)) ? { root: path.dirname(dir), layout: "grouped" } : { root: dir, layout: "flat" };
}

export function isTopLevelSessionFile(file: string, root: SessionsRoot): boolean {
  const resolved = path.resolve(file);
  if (!resolved.endsWith(SESSION_EXTENSION)) return false;
  const parent = path.dirname(resolved);
  return path.resolve(root.root) === (root.layout === "grouped" ? path.dirname(parent) : parent);
}

async function directoryEntries(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function headerIdOf(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(NEWLINE);
    if (end < 0) return undefined;
    const header: unknown = JSON.parse(buffer.toString("utf8", 0, end));
    if (typeof header !== "object" || header === null) return undefined;
    const { type, id } = header as { type?: unknown; id?: unknown };
    return type === "session" && typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

// Every top-level session file with a readable header, sorted by path. A file without a complete header line is
// still being created and is left for the next start.
export async function listTopLevelSessionFiles(root: SessionsRoot): Promise<SessionFileRef[]> {
  const candidates: string[] = [];
  const collect = async (dir: string): Promise<void> => {
    for (const entry of await directoryEntries(dir)) {
      if (entry.isFile() && entry.name.endsWith(SESSION_EXTENSION)) candidates.push(path.join(dir, entry.name));
    }
  };

  if (root.layout === "flat") {
    await collect(root.root);
  } else {
    for (const entry of await directoryEntries(root.root)) {
      if (entry.isDirectory()) await collect(path.join(root.root, entry.name));
    }
  }

  const refs: SessionFileRef[] = [];
  for (const file of candidates.sort()) {
    const headerId = await headerIdOf(file);
    if (headerId === undefined) continue;
    try {
      const stat = await fs.promises.stat(file);
      refs.push({ path: file, headerId, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return refs;
}

// The file up to its last newline: what comes after belongs to a line pi is still writing. Old formats are
// migrated by pi's own migration, so the entries are always in the current shape. `entries` excludes the header.
export async function readSessionFile(file: string): Promise<Result<SessionRead, string>> {
  const bytes = await readBytes(file);
  if (!bytes.ok) return { ok: false, error: bytes.error.detail };

  const endOffset = bytes.value.lastIndexOf(NEWLINE) + 1;
  if (endOffset === 0) return { ok: false, error: `${file}: no complete line` };

  let parsed: FileEntry[];
  try {
    parsed = parseSessionEntries(bytes.value.toString("utf8", 0, endOffset));
    migrateSessionEntries(parsed);
  } catch (error) {
    return { ok: false, error: `${file}: ${toErrorMessage(error)}` };
  }

  const [header, ...entries] = parsed;
  if (header === undefined || header.type !== "session") return { ok: false, error: `${file}: no session header` };
  return { ok: true, value: { header: header as SessionHeader, entries, endOffset } };
}

function isWithin(dir: string, target: string): boolean {
  return target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

// A cwd the observer never reads sessions of: scratch directories (replay children, throwaway runs) and directories
// that are gone, where nothing could be replayed. `tmpdirs` adds the platform's temp directory to /tmp and /private/tmp.
export function isExcludedCwd(cwd: string, exists: (dir: string) => boolean, tmpdirs: readonly string[]): boolean {
  if (cwd === "" || !path.isAbsolute(cwd)) return true;
  const resolved = path.resolve(cwd);
  if ([...ALWAYS_EXCLUDED_DIRS, ...tmpdirs].some((dir) => isWithin(path.resolve(dir), resolved))) return true;
  return !exists(resolved);
}
