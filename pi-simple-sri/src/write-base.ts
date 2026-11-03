import path from "node:path";
import { SriPerimeterError } from "./errors.ts";
import { isInsideOrEqual, resolveExistingAncestor } from "./perimeter.ts";
import { quote } from "./values.ts";

// Where a run writes: `<agentDir>/sri`, with staging/ and state/ under it.
//
// The anchor used to be the package root (packageRoot, before this slice). With `pi -e .` that is
// the checkout, but with `pi install npm:pi-simple-sri` it is
// ~/.pi/agent/npm/node_modules/pi-simple-sri, so staging/ and state/ landed inside the npm
// installation: an upgrade takes them away, and a package directory is not the user's to write in.
// The agent directory is pi's own (getAgentDir, overridable with PI_CODING_AGENT_DIR), it survives
// reinstalls, and `sri` below it keeps this package's files out of pi's own tree.
//
// These functions only compute paths. None of them creates a directory: the first writer that needs
// one creates it, so asking where things go never has a side effect, and a base that cannot be
// written fails at the write, not here.

const BASE_DIR = "sri";

export function writeBase(agentDir: string): string {
  return path.join(agentDir, BASE_DIR);
}

export function stagingDir(base: string): string {
  return path.join(base, "staging");
}

export function stateDir(base: string): string {
  return path.join(base, "state");
}

// Records and answers name a candidate relative to the base of the run and never by absolute path: a
// record stays readable after the agent directory moves, and no machine-specific path enters
// decision.json or the audit index.
//
// A target outside the base keeps its absolute spelling, because path.relative would answer "../..",
// which reads as a relative path that does not exist. Nothing this package writes leaves the base, so
// that branch is a guard and not a case. What is looked at is the first segment and not the prefix: a
// name that starts with two dots without being `..`, such as `..foo`, is inside the base.
export function relativeToBase(base: string, target: string): string {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative === "" || relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)) return resolvedTarget;
  return relative;
}

// A base inside the skill the run improves: staging would become a part of the skill and the audit
// index would land next to its SKILL.md. This package never writes inside a skill (only M1's accepted
// write will, and under its own snapshot), so the run is refused before the index is touched, since
// both of its writes land under the base.
//
// Every spelling of the skill is compared because the inventory keeps the linked path and the real one
// (F5), and a skill reached through a symlink is the usual case here.
//
// Both sides are resolved through the existing part of the path before they are compared: a declared
// string comparison accepts a base that reaches the skill through a symlink, and the write perimeter
// cannot catch that afterwards because its root is <base>/staging, which is already inside the link.
// A base that does not exist yet resolves to its resolved prefix plus the missing tail, so a guard that
// runs before the first write still compares what the filesystem will do.
export function assertBaseOutsideSkill(base: string, skillDirs: readonly string[]): void {
  const resolvedBase = resolveExistingAncestor(base);
  for (const skillDir of skillDirs) {
    const resolvedSkillDir = resolveExistingAncestor(skillDir);
    if (isInsideOrEqual(resolvedBase, resolvedSkillDir)) {
      throw new SriPerimeterError(
        `refusing to run: the write base ${quote(base)} resolves to ${quote(resolvedBase)}, inside the skill directory ${quote(resolvedSkillDir)}`,
        resolvedBase,
      );
    }
  }
}
