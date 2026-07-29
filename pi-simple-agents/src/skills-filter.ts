export interface SkillsFilterResult<T extends { name: string }> {
  skills: T[]; // order of base preserved
  missing: string[]; // names requested without a match, request order, deduplicated
}

export function filterSkillsByName<T extends { name: string }>(
  base: readonly T[],
  requested: readonly string[],
): SkillsFilterResult<T> {
  const requestedSet = new Set(requested);
  const skills = base.filter((item) => requestedSet.has(item.name));

  const baseNames = new Set(base.map((item) => item.name));
  const missing = [...new Set(requested)].filter((n) => !baseNames.has(n));

  return { skills, missing };
}
