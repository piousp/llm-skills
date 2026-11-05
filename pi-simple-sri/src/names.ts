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
// The record of a retirement, written inside the snapshot the retirement took before touching the skill (M3, S4). It is
// not decision.json: a decision describes what a gate decided about a candidate, and a retirement is no verdict about
// one -- it is the reason a user gave for a lesson that stops applying, with the hashes of the lesson that was accepted.
export const RETIREMENT_FILE = "retirement.json";
// The append-only index of attempts, one JSON line per event (Q14).
export const ATTEMPTS_FILE = "attempts.jsonl";
// The append-only file of the suspicious occurrences the extension notices while a session happens (M3, S5): one JSON
// line per event, `raised` and `consumed`. It lives next to the index of attempts, under state/, because it is the memory
// that survives the session which raised the suspicion, and it is its own file because a suspicion is not an attempt.
export const SIGNALS_FILE = "signals.jsonl";
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

// The settings file of pi's agent directory, the one `pi-simple-sri` reads its own key from (Q16). It was a private literal of
// src/improve-flow.ts and M3 needs it in the gate too (the eligibility re-check of D-C), which is the reason it moves here: two
// modules build the same path from it, and a second copy is a typo away from reading a file the user never wrote.
export const SETTINGS_FILE = "settings.json";

// The environment variable a replay sets for its child (OA8), and the one the extension reads to
// register nothing inside a replay. Two modules agree on this literal and one of them is what stops
// the child from starting another propose or gate over itself, so it is a constant and not a string
// written twice.
export const REPLAY_ENV_VAR = "PI_SIMPLE_SRI_REPLAY";
