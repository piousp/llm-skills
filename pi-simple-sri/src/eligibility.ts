import path from "node:path";
import { PUBLISHED_SKILL_NAME } from "./names.ts";
import type { Eligibility, SriConfig } from "./types.ts";

// Q15: allow/deny hold exact skill names. No globs, no case folding, no trimming;
// `deny` wins over `allow`; an empty `allow` admits every skill that `deny` does
// not name and that is not the reserved name below. A config read from disk always carries both arrays (see config.ts).
//
// A skill answers to two spellings (F5): the `name` of its frontmatter and the basename of its
// directory, and src/skills-inventory.ts findSkill resolves a request written either way. The
// settings are written by hand, so either spelling may be the one the user wrote, and a verdict that
// looked at one of them would depend on which one was picked. The rule is therefore taken over every
// spelling the skill has: `deny` wins when any spelling matches, `allow` admits when any spelling
// matches, and an empty `allow` admits every skill `deny` does not name, but for the reserved name. `isEligible` is the same
// rule for a skill that has one spelling.
//
// The name this package reserves is refused before either list is read (M2c, S2b). What is reserved is the name
// `improving-skills`, which this package publishes its manual under (PUBLISHED_SKILL_NAME): a lesson written in a skill of
// that name does not survive an update of the package, because the update brings its own copy of the file. The rule compares
// the name and not the directory, on purpose -- the name is what an update collides with, and a directory it could compare
// would make the verdict depend on where the skill was installed -- so a skill of the user that took the name is refused
// under the same reason. It is therefore not a default of the `deny` list: a user who denies that name and a user who allows
// it both get the same answer, and the reason says whose decision it was.
export function isEligible(skillName: string, config: SriConfig): Eligibility {
  return isEligibleUnderAnySpelling([skillName], config);
}

// The spellings of one skill, which are the argument of the rule above (F5): the `name` of the frontmatter and the
// basename of the directory, in that order, and one spelling when the two agree. It moved here from
// src/improve-flow.ts (M3, S7) because it had two owners waiting: the loop, the gate and the acceptance take the same
// verdict, and a private copy in each would be a second answer to "which names does the settings file decide about" --
// the day one of them learned about a third spelling, the other two would quietly decide about two.
export function spellingsOfSkill(skill: { name: string; dir: string }): string[] {
  const dirName = path.basename(skill.dir);
  return dirName === skill.name ? [skill.name] : [skill.name, dirName];
}

export function isEligibleUnderAnySpelling(
  skillNames: readonly string[],
  config: SriConfig,
): Eligibility {
  if (skillNames.some((skillName: string) => skillName === PUBLISHED_SKILL_NAME)) {
    return { eligible: false, reason: "published-by-this-package" };
  }
  if (skillNames.some((skillName: string) => config.deny.includes(skillName))) {
    return { eligible: false, reason: "not-eligible" };
  }
  if (config.allow.length === 0 || skillNames.some((skillName: string) => config.allow.includes(skillName))) {
    return { eligible: true };
  }
  return { eligible: false, reason: "not-eligible" };
}

// The verdict of one skill under the settings of one run (B4): the rule above over the spellings the skill answers to (F5).
// It is the one owner of the pair `spellingsOfSkill` + `isEligibleUnderAnySpelling`, which the loop, the gate and the
// acceptance each spelled out -- the day one of them learned about a third spelling, the other two would have gone on
// deciding about two. What it decides is the rule of this module; where the settings come from is the caller's, which is why
// the config arrives as data and not as a path.
export function eligibilityOfSkill(skill: { name: string; dir: string }, config: SriConfig): Eligibility {
  return isEligibleUnderAnySpelling(spellingsOfSkill(skill), config);
}
