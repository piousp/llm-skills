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
