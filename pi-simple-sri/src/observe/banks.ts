import path from "node:path";
import { MAX_CASES, MIN_CASES, readCaseBank } from "../case-bank.ts";
import type { CaseBank } from "../case-bank.ts";
import { CASE_BANK_FILE } from "../names.ts";
import type { SkillRef } from "../types.ts";
import { banksDir } from "../write-base.ts";
import { containsSecret } from "./redact.ts";
import type { EpisodeEvent, ObserveState, PatternView, Provenance } from "./types.ts";

// Which bank measures a skill, and which episodes may become the cases of a bank that does not exist yet. Neither
// function writes: the bank of the user lives in <base>/banks and the legacy one inside the skill, read-only.

// Three answers, and the third is not the second: a bank that is there and cannot be used is not the absence of a bank,
// because a generated one would replace it.
export type ResolvedBank =
  | { kind: "found"; path: string; provenance: Provenance; bank: CaseBank }
  | { kind: "absent" }
  | { kind: "unusable"; path: string };

export function bankPathOf(base: string, skillName: string): string {
  return path.join(banksDir(base), `${skillName}.json`);
}

// The bank of the user first, then the one the skill ships. A bank that is there and cannot be read is `unusable`, and does
// not fall through to the other: a broken bank must not be replaced silently by a different one. A name that is a path has
// no bank.
export async function resolveBank(
  base: string,
  skill: Pick<SkillRef, "name" | "realDir">,
): Promise<ResolvedBank> {
  if (skill.name === "" || path.basename(skill.name) !== skill.name) return { kind: "absent" };

  const own = bankPathOf(base, skill.name);
  const owned = await readCaseBank(own, "baseline");
  if (owned.ok) {
    return { kind: "found", path: own, provenance: owned.value.bank.provenance ?? "user", bank: owned.value.bank };
  }
  if (owned.error.error !== "absent") return { kind: "unusable", path: own };

  const legacy = path.join(skill.realDir, CASE_BANK_FILE);
  const shipped = await readCaseBank(legacy, "baseline");
  if (shipped.ok) return { kind: "found", path: legacy, provenance: "skill-shipped", bank: shipped.value.bank };
  return shipped.error.error === "absent" ? { kind: "absent" } : { kind: "unusable", path: legacy };
}

export type BankEpisodeSelection = { cwd: string; episodes: EpisodeEvent[] } | { pending: true; reason: string };

// The verbatim user text of an episode, or null when it cannot be read. When given, an episode whose text holds a
// secret is excluded, never redacted: a redacted prompt would not be what the user asked.
export type PromptOf = (episode: EpisodeEvent) => string | null;

// At least MIN_CASES episodes from at least 2 sessions, all of them in one cwd that still exists: the gate runs the
// cases there. The cwd of the session that is open wins; otherwise the one with the most sessions (then the most
// episodes, then the smaller path, so the answer does not depend on the order of the log).
export function selectBankEpisodes(
  pattern: PatternView,
  state: ObserveState,
  ctxCwd: string,
  exists: (cwd: string) => boolean,
  promptOf?: PromptOf,
): BankEpisodeSelection {
  const observed = new Set(pattern.observationIds);
  const episodeIds = new Set<string>();
  for (const observation of state.observations) {
    if (observed.has(observation.id) && observation.episodeId !== null) episodeIds.add(observation.episodeId);
  }

  const byCwd = new Map<string, EpisodeEvent[]>();
  for (const episode of state.episodes) {
    if (!episodeIds.has(episode.id) || episode.skill !== pattern.skill) continue;
    if (!exists(episode.cwd)) continue;
    if (promptOf !== undefined) {
      const prompt = promptOf(episode);
      if (prompt === null || containsSecret(prompt)) continue;
    }
    const group = byCwd.get(episode.cwd) ?? [];
    if (!group.some((known) => known.id === episode.id)) group.push(episode);
    byCwd.set(episode.cwd, group);
  }

  const usable = [...byCwd.entries()]
    .map(([cwd, episodes]) => ({ cwd, episodes, sessions: new Set(episodes.map((e) => e.sessionId)).size }))
    .filter((group) => group.episodes.length >= MIN_CASES && group.sessions >= 2);

  if (usable.length === 0) {
    return { pending: true, reason: `fewer than ${MIN_CASES} usable episodes from 2 sessions in one existing cwd` };
  }

  usable.sort(
    (a, b) =>
      Number(b.cwd === ctxCwd) - Number(a.cwd === ctxCwd) ||
      b.sessions - a.sessions ||
      b.episodes.length - a.episodes.length ||
      (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0),
  );

  const chosen = usable[0];
  if (chosen === undefined) return { pending: true, reason: "no usable cwd" };
  const episodes = [...chosen.episodes].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(0, MAX_CASES);
  return { cwd: chosen.cwd, episodes };
}
