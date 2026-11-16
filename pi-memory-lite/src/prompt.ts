// The conditional section this package writes into the system prompt, and the one place its conditions and its wording
// live. Pure: no host import, no I/O, no clock. The section is a function of the session state the host hands the
// `before_agent_start` handler, so every branch is a test of three string lists and, for the choice of mechanism, of the
// exposure the settings resolved.
//
// Why it exists at all: `exposure` and the session's tool list together decide whether the model is told these four tools
// exist. With `codemode` or `deferred` the host keeps their declarations out of `<tools>`, and a static skill cannot
// close that gap — it cannot read the resolved exposure, whether `tool_search` is declared, or whether `hiddenTools`
// removed a declaration it does list. The entrypoint therefore asks this module what the live session deserves and
// writes the answer into `systemPromptOptions.sections`, or deletes the key.
//
// What the section never does: carry memory content. It names the tools and the mechanism that reaches them, and the
// promise of the package is "never silently unusable" — in the unreachable case the section reports and nothing
// self-heals.
//
// Why the registry is read first: the two tool lists say what the prompt declares, and they cannot tell "hidden for this
// turn" apart from "not there at all". A `-t` allowlist that leaves one of the four out filters it out of the session
// registry, and a tool the registry does not hold is not merely undeclared: `tool_search` cannot return it and a codemode
// script cannot call it. `registeredTools` is what carries that distinction, so a name missing from it short-circuits both
// mechanisms instead of promising one that cannot work.
//
// Why the exposure is read here, and at exactly one point: `tool_search` only indexes the tools whose exposure is
// `codemode` or `deferred` (`isSearchable` of the host's tool-search extension), so it is a remedy only for the modes that
// took the declarations away. With `direct` the declarations are gone for another reason — a `-t` allowlist, or
// `codemode.mode: "only"` hiding the declarations of the callable `direct` tools — and a search would never return them,
// so the section falls through to the script. The "missing" computation itself reads only the two tool lists: the exposure
// chooses between the two remedies and nothing else.

import type { Exposure } from "./config.ts";
import { MEMORY_TOOL_NAMES } from "./tools.ts";

/**
 * Tag of the section in `systemPromptOptions.sections`, which is the name the host wraps it with: it has to match the
 * host's `/^[a-z][a-z0-9_-]*$/`, it may not be `preamble`, and it is namespaced so the delete branch can never remove a
 * section another extension owns.
 */
export const MEMORY_PROMPT_SECTION = "memory_lite";

/**
 * What the section says, which is what decides where else it goes: the two mechanisms name themselves, and `unreachable`
 * is the case the user is warned about, once, because it does not repair itself.
 */
export type MemoryPromptSection = {
  readonly kind: "tool_search" | "codemode" | "unreachable";
  readonly text: string;
};

/**
 * The state of the host's prompt the section is a function of, and the whole of its input. The two lists decide whether
 * there is a section and which names it spells; the registry decides whether any mechanism can reach the tools at all; the
 * exposure decides only which of the two mechanisms the section may promise, because `tool_search` indexes only the
 * non-`direct` tools.
 */
export type MemoryPromptInput = {
  /** `systemPromptOptions.selectedTools`, as the host lists them for this turn. */
  readonly selectedTools: readonly string[];
  /** `systemPromptOptions.hiddenTools`: what `prepareLoadout` removed from the declarations requests. */
  readonly hiddenTools: readonly string[];
  /**
   * The names the session registry holds, from `pi.getAllTools()`. The two lists above cannot tell a declaration hidden for
   * this turn apart from a tool the session does not have, and a `-t` allowlist that leaves one of the four out means the
   * second: no search returns it and no script calls it.
   */
  readonly registeredTools: readonly string[];
  /** The `exposure` resolved from the settings for this session, which is what explains why the declarations are gone. */
  readonly exposure: Exposure;
};

/**
 * The section this turn needs, or `undefined` when the four tools are declared and the prompt already names them. The
 * order of the branches is the contract: a name the registry does not hold comes first, because then neither mechanism can
 * reach it; then `tool_search` before `codemode`, because a declared `tool_search` keeps the tools declared for the rest of
 * the session and a script would have to be written again on every turn — but only when the exposure is one of the two
 * that `tool_search` indexes.
 */
export function memoryPromptSectionFor(input: MemoryPromptInput): MemoryPromptSection | undefined {
  const declared = input.selectedTools.filter((name) => !input.hiddenTools.includes(name));
  const missing = MEMORY_TOOL_NAMES.filter((name) => !declared.includes(name));

  // Nothing to report, and `undefined` rather than an empty string: an empty body is a section the host skips, so
  // returning one would leave the delete branch of the entrypoint without its invariant.
  if (missing.length === 0) return undefined;

  // A tool the session registry does not hold is out of reach of both mechanisms, so naming one would send the model after
  // something that never comes back — the defect that four turns of a live session were spent on. The text is unchanged
  // because it is true here: the tools are not declared, and neither mechanism can call them.
  if (MEMORY_TOOL_NAMES.some((name) => !input.registeredTools.includes(name))) {
    return { kind: "unreachable", text: UNREACHABLE_TEXT };
  }

  const names = joinNames(missing);
  // The one place the exposure is read: `tool_search` cannot find a tool whose exposure is `direct`, so promising it there
  // would send the model after something that never comes back.
  if (input.exposure !== "direct" && declared.includes("tool_search")) {
    return { kind: "tool_search", text: toolSearchText(names) };
  }
  if (declared.includes("codemode")) return { kind: "codemode", text: codemodeText(names) };
  return { kind: "unreachable", text: UNREACHABLE_TEXT };
}

/**
 * The section of a session that can find the tools: a match in `tool_search` declares what it found for the rest of the
 * session, which is why this mechanism is preferred over a script. The sentence says "installed" and not "registered"
 * because a `-t` allowlist that does not name the four filters them out of the session registry: they are then neither
 * declared, nor callable from a script, nor visible to `tool_search`.
 */
function toolSearchText(names: string): string {
  return `Memory tools are installed but not declared in this prompt: ${names}. Find them with tool_search; a match stays declared for the rest of the session.`;
}

/** The section of a session whose scripts can call the tools although the prompt does not declare them. */
function codemodeText(names: string): string {
  return `Memory tools are installed but not declared in this prompt: ${names}. Call them from a codemode script: searchTools("memory") returns them and ALL_TOOLS lists all callable tools.`;
}

/**
 * The section of a session with no way in. It names the ways out, because the model can neither call these tools nor
 * enable a mechanism, and the user is the one who can do either. The allowlist is one of them: a `-t` list that leaves
 * one of the four out removes it from the registry, which is the same dead end as an exposure with no mechanism.
 */
const UNREACHABLE_TEXT = `Memory tools are installed but unreachable in this session: they are not declared, and neither tool_search nor codemode can call them. Enable tool_search, enable codemode, set exposure "direct", or check the tools allowlist of the session; otherwise the memory is never read or written.`;

/**
 * The names as one paragraph reads them: `a`, `a and b`, `a, b and c`. No serial comma, so four names read the way the
 * declarations and the descriptions of the four tools already name them. The sentences around the list hold no number
 * agreement with it, so one name and four names read the same.
 */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
