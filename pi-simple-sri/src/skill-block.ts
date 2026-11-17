import { parseSkillBlock } from "@earendil-works/pi-coding-agent";

export interface SplitSkillBlock {
  skill: { name: string; location: string } | null;
  userText: string;
}

// pi expands `/skill:x args` into a <skill> block followed by the args. Only what the user typed
// is evidence or a prompt: the block is the skill's own text and must never be read as one.
export function splitSkillBlock(text: string): SplitSkillBlock {
  const parsed = parseSkillBlock(text);
  if (parsed === null) return { skill: null, userText: text };

  return {
    skill: { name: parsed.name, location: parsed.location },
    userText: parsed.userMessage ?? "",
  };
}
