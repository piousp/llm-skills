// File and directory names that more than one module builds a path from, plus the two names a user
// or a model types (I15). Each of them was a private literal in two or more modules, so a typo in one
// of the copies would have pointed that module at a different file -- or registered a different
// command -- than the rest of the package.

// The command this package registers. One owner: the registration and every sentence that names it
// read it from here.
export const COMMAND_NAME = "skill-improve";
// The tool this package registers, for the same reason: the name the model calls and the sentences
// that name it are one literal.
export const SKILL_IMPROVE_TOOL_NAME = "skill_improve";

// The file that makes a directory a declared skill; also the file the M1 writes edit.
export const SKILL_FILE = "SKILL.md";
// Holds one <slug>.md per lesson, next to SKILL.md.
export const LESSONS_DIR = "lessons";
// Inside a skill directory: one snapshot directory per timestamp, never rewritten.
export const HISTORY_DIR = ".history";
// Written next to the lesson inside a staging candidate.
export const DECISION_FILE = "decision.json";
// The append-only index of attempts, one JSON line per event (Q14).
export const ATTEMPTS_FILE = "attempts.jsonl";
// The neutral bank of cases of M1c: the file a `--bank=<path>` names, and the name of the copy the gate leaves next
// to the staged candidate so the cases it ran travel with it (Q24). Two modules build a path from this literal, which
// is why it lives here; the versioned id of the format is not a file name and stays in src/case-bank.ts.
export const CASE_BANK_FILE = "case-bank.json";

// The name this package reserves for the manual it publishes (skills/improving-skills). It is the one name the loop refuses
// to improve whatever the settings say: a lesson written in a skill of that name does not survive an update of the package, so
// the name is a constant the rule and the tests read from one place. The packaging is not one of them: what the package ships
// is declared in package.json, which does not read this constant, and the edit of that list and of this literal travel
// together by hand.
export const PUBLISHED_SKILL_NAME = "improving-skills";

// The environment variable a replay sets for its child (OA8), and the one the extension reads to
// register nothing inside a replay. Two modules agree on this literal and one of them is what stops
// the child from starting another propose or gate over itself, so it is a constant and not a string
// written twice.
export const REPLAY_ENV_VAR = "PI_SIMPLE_SRI_REPLAY";
