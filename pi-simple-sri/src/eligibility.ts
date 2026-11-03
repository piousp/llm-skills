import type { Eligibility, SriConfig } from "./types.ts";

// Q15: allow/deny hold exact skill names. No globs, no case folding, no trimming;
// `deny` wins over `allow`; an empty `allow` admits every skill that `deny` does
// not name. A config read from disk always carries both arrays (see config.ts).
//
// A skill answers to two spellings (F5): the `name` of its frontmatter and the basename of its
// directory, and src/skills-inventory.ts findSkill resolves a request written either way. The
// settings are written by hand, so either spelling may be the one the user wrote, and a verdict that
// looked at one of them would depend on which one was picked. The rule is therefore taken over every
// spelling the skill has: `deny` wins when any spelling matches, `allow` admits when any spelling
// matches, and an empty `allow` admits every skill `deny` does not name. `isEligible` is the same
// rule for a skill that has one spelling.
export function isEligible(skillName: string, config: SriConfig): Eligibility {
  return isEligibleUnderAnySpelling([skillName], config);
}

export function isEligibleUnderAnySpelling(
  skillNames: readonly string[],
  config: SriConfig,
): Eligibility {
  if (skillNames.some((skillName: string) => config.deny.includes(skillName))) {
    return { eligible: false, reason: "not-eligible" };
  }
  if (config.allow.length === 0 || skillNames.some((skillName: string) => config.allow.includes(skillName))) {
    return { eligible: true };
  }
  return { eligible: false, reason: "not-eligible" };
}
