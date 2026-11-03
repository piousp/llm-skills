import fs from "node:fs";
import path from "node:path";
import { SriPerimeterError } from "./errors.ts";
import { isMissingPathError, quote, toErrorMessage } from "./values.ts";

// Write perimeter. pi runs extensions without a sandbox (docs/security.md:3), so this
// check is the only thing between a generated skill name, slug or timestamp and the
// user's filesystem. It fails closed: a target that cannot be proven to be inside one
// of the given roots is rejected with SriPerimeterError.
//
// Two independent checks run and both must pass:
//   1. the normalized target is inside a root as the caller spelled it;
//   2. the deepest part of the target that already exists, resolved with realpathSync,
//      is inside a root resolved with realpathSync.
// The second check is what catches a symlink planted inside the root: the string form
// looks contained, the resolved form does not. The first check keeps a symlinked root
// usable (Q11: writes go through the skill's symlink) and rejects siblings such as
// /a/bc for the root /a/b.
//
// Containment is compared with the path separator appended, never with a bare
// startsWith, so /a/bc never counts as inside /a/b.

// Error messages stay short: a long root list on every rejection is unreadable.
const MAX_ROOTS_LISTED = 3;

// The error class lives in src/errors.ts with the rest of the fail-closed errors; it is
// re-exported here because this is the module that raises it.
export { SriPerimeterError };

interface WritableRoot {
  declared: string; // as the caller wrote it, normalized
  real: string; // realpathSync of the same directory
}

// `target` is absolute and may not exist yet (a lesson file is written into a directory
// that was just created). `roots` are absolute directories that must exist: the realpath
// of an eligible skill directory, and the package's staging/ and state/ directories.
export function assertWritable(target: string, roots: readonly string[]): void {
  if (roots.length === 0) {
    throw new SriPerimeterError(`refusing to write ${quote(target)}: no writable root was given`, target);
  }
  if (!path.isAbsolute(target)) {
    throw new SriPerimeterError(`refusing to write ${quote(target)}: the target is not absolute`, target);
  }

  const resolvedRoots = roots.map((root) => resolveWritableRoot(root, target));
  const declaredTarget = path.resolve(target);

  if (!resolvedRoots.some((root) => isInsideOrEqual(declaredTarget, root.declared))) {
    const listed = listRoots(resolvedRoots.map((root) => root.declared));
    throw new SriPerimeterError(`refusing to write ${quote(declaredTarget)}: it is outside every writable root (${listed})`, target);
  }

  const ancestor = deepestExistingAncestor(declaredTarget, target);
  const realAncestor = resolveRealPath(ancestor, target);
  if (!resolvedRoots.some((root) => isInsideOrEqual(realAncestor, root.real))) {
    const listed = listRoots(resolvedRoots.map((root) => root.real));
    throw new SriPerimeterError(
      `refusing to write ${quote(declaredTarget)}: its existing part ${quote(ancestor)} resolves to ${quote(realAncestor)}, outside every writable root (${listed})`,
      target,
    );
  }
}

function resolveWritableRoot(root: string, target: string): WritableRoot {
  if (!path.isAbsolute(root)) {
    throw new SriPerimeterError(`refusing to write ${quote(target)}: the writable root ${quote(root)} is not absolute`, target);
  }

  const declared = path.resolve(root);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(declared);
  } catch (error) {
    throw new SriPerimeterError(
      `refusing to write ${quote(target)}: the writable root ${quote(declared)} cannot be read (${toErrorMessage(error)})`,
      target,
    );
  }

  if (!stats.isDirectory()) {
    throw new SriPerimeterError(`refusing to write ${quote(target)}: the writable root ${quote(declared)} is not a directory`, target);
  }

  return { declared, real: resolveRealPath(declared, target) };
}

function resolveRealPath(targetPath: string, reportedTarget: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch (error) {
    throw new SriPerimeterError(
      `refusing to write ${quote(reportedTarget)}: cannot resolve ${quote(targetPath)} (${toErrorMessage(error)})`,
      reportedTarget,
    );
  }
}

// Walks up until it finds something that exists. The filesystem root always exists, so
// the loop terminates.
function deepestExistingAncestor(absoluteTarget: string, reportedTarget: string): string {
  let current = absoluteTarget;
  for (;;) {
    try {
      // lstat and not stat: a symlink ancestor must be found as itself so the realpath
      // check below sees where it points.
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new SriPerimeterError(
          `refusing to write ${quote(reportedTarget)}: cannot inspect ${quote(current)} (${toErrorMessage(error)})`,
          reportedTarget,
        );
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

// The one containment rule of the package: a candidate is inside a root when it is the root or starts
// with the root plus a separator, never with a bare prefix. Exported because src/write-base.ts asks the
// same question about the base and a skill directory, and a second copy of this rule is a second place
// where /a/bc could count as inside /a/b.
export function isInsideOrEqual(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

function listRoots(roots: readonly string[]): string {
  const listed = roots.slice(0, MAX_ROOTS_LISTED).map(quote).join(", ");
  const hidden = roots.length - MAX_ROOTS_LISTED;
  return hidden > 0 ? `${listed} and ${hidden} more` : listed;
}
