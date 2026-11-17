import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OBSERVE_LOCK_FILE } from "../names.ts";
import type { Result } from "../types.ts";
import { isMissingPathError } from "../values.ts";
import { stateDir } from "../write-base.ts";
import { createExclusiveFile, ensurePrivateDir, removeFileIn, writePrivateFile } from "../writer.ts";
import { LOCK_HEARTBEAT_MS, LOCK_STALE_MS } from "./types.ts";

// The lock of the scan and the forget: state/observe.lock, claimed with O_EXCL (createExclusiveFile) and kept alive by a
// heartbeat that rewrites it. It guards the two operations that read a whole file and write it back; appends never take it
// (OA11), and the gate never runs under it.
//
// A lock is stale when its file was last written more than LOCK_STALE_MS ago: the process that held it died or hung. The
// next caller takes it over. Every holder carries a token and checks it before it beats and before it releases, so a
// holder that was taken over finds out (its signal aborts) and never removes the lock of the one that replaced it.

export interface ScanLockOptions {
  // Milliseconds since the epoch; injected so a test can age a lock without waiting for it.
  now?: () => number;
  heartbeatMs?: number;
  staleMs?: number;
}

interface LockBody {
  token: string;
  pid: number;
  beats: number;
}

function lockBodyText(body: LockBody): string {
  return `${JSON.stringify(body)}\n`;
}

async function readLockText(lockPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(lockPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function tokenOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const token = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "token") : undefined;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

async function ageOf(lockPath: string, now: () => number): Promise<number | null> {
  try {
    return now() - (await fs.promises.stat(lockPath)).mtimeMs;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

// Runs `fn` holding the lock and answers its value, or `locked` when somebody else holds a lock that is not stale. `fn`
// receives a signal that aborts when this holder lost the lock or could not keep it alive. The lock is released when `fn`
// settles, whichever way.
export async function withScanLock<T>(
  base: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: ScanLockOptions = {},
): Promise<Result<T, "locked">> {
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;

  const root = stateDir(base);
  ensurePrivateDir(root, base);
  const lockPath = path.join(root, OBSERVE_LOCK_FILE);
  const token = randomUUID();
  const body: LockBody = { token, pid: process.pid, beats: 0 };

  if (!(await createExclusiveFile(lockPath, lockBodyText(body), root))) {
    // Held. It is taken over only if it is stale, and only the very lock that was judged stale: the content is read again
    // before the removal, so a lock that changed hands in between is left alone.
    const age = await ageOf(lockPath, now);
    const judged = await readLockText(lockPath);
    if (age !== null && age <= staleMs) return { ok: false, error: "locked" };
    if (judged !== null && (await readLockText(lockPath)) === judged) await removeFileIn(lockPath, root);
    if (!(await createExclusiveFile(lockPath, lockBodyText(body), root))) return { ok: false, error: "locked" };
  }

  const controller = new AbortController();
  let beating: Promise<void> = Promise.resolve();

  const beat = async (): Promise<void> => {
    try {
      if (tokenOf(await readLockText(lockPath)) !== token) {
        controller.abort();
        return;
      }
      body.beats += 1;
      await writePrivateFile(lockPath, lockBodyText(body), root);
    } catch {
      controller.abort();
    }
  };

  const timer = setInterval(() => {
    beating = beating.then(beat);
  }, heartbeatMs);
  timer.unref();

  try {
    return { ok: true, value: await fn(controller.signal) };
  } finally {
    clearInterval(timer);
    await beating;
    try {
      if (tokenOf(await readLockText(lockPath)) === token) await removeFileIn(lockPath, root);
    } catch {
      // Swallowed on purpose: a lock that cannot be removed goes stale, and the result of `fn` is not hers to hide.
    }
  }
}
