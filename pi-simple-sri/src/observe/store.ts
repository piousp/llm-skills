import fs from "node:fs";
import path from "node:path";
import { SriWriterError } from "../errors.ts";
import { OBSERVE_FILE } from "../names.ts";
import { stateDir } from "../write-base.ts";
import { appendObserveLine } from "../writer.ts";
import { isMissingPathError, isPlainObject, quote, toErrorMessage } from "../values.ts";
import { CUTOFF_DAYS, OBSERVE_EVENT_TYPES, OBSERVE_FORMAT } from "./types.ts";
import type { EpisodeEvent, ObserveEvent, ObserveState, ObservationEvent } from "./types.ts";

// The reader and the fold of state/observe.jsonl. The append is src/writer.ts (appendObserveLine); this module adds the
// tolerant read, the batch append and the fold every other module of the observer asks its questions of. The fold is
// pure: the clock is a parameter, and decay is the reader's job (src/observe/beta.ts), never stored here.

const DAY_MS = 24 * 60 * 60 * 1000;

// The fields the fold dereferences: a line without them is not an event this version can use. The rest of the shape is
// the writer's (the schema documents it), the way the signals reader trusts the lines of its own format.
const REQUIRED_STRINGS: Readonly<Record<ObserveEvent["type"], readonly string[]>> = {
  "opt-in": [],
  episode: ["id", "skill", "sessionId", "startedAt"],
  judged: ["episodeId"],
  observation: ["id", "skill", "sessionId"],
  proposal: ["id", "skill"],
  "prepare-failed": ["skill", "patternId"],
  prompt: ["proposalId"],
  "gate-outcome": ["proposalId"],
  tombstone: ["patternId", "skill"],
  forget: ["skill"],
};

export function observeLogPath(base: string): string {
  return path.join(stateDir(path.resolve(base)), OBSERVE_FILE);
}

function isObserveEvent(value: unknown): value is ObserveEvent {
  if (!isPlainObject(value) || value.format !== OBSERVE_FORMAT || typeof value.at !== "string") return false;
  const type = value.type;
  if (typeof type !== "string" || !(OBSERVE_EVENT_TYPES as readonly string[]).includes(type)) return false;
  return REQUIRED_STRINGS[type as ObserveEvent["type"]].every((field) => typeof value[field] === "string");
}

// Every event of the log, in file order. Tolerant by contract: a line that is not JSON, of another format, of a type this
// version does not know or without the fields above is skipped, and the text after the last newline -- an append that was
// never finished -- is dropped instead of read as the event it almost was. An absent log is the first run: no events.
export async function readObserveLog(base: string): Promise<ObserveEvent[]> {
  const logPath = observeLogPath(base);
  let text: string;
  try {
    text = await fs.promises.readFile(logPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw new SriWriterError(`cannot read ${quote(logPath)}: ${toErrorMessage(error)}`, logPath);
  }

  const rawLines = text.split("\n");
  rawLines.pop();

  const events: ObserveEvent[] = [];
  for (const raw of rawLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (isObserveEvent(parsed)) events.push(parsed);
  }
  return events;
}

// One line per event, in order. Sequential on purpose: the order of the log is the order of the calls.
export async function appendObserveEvents(base: string, events: readonly ObserveEvent[]): Promise<void> {
  for (const event of events) {
    await appendObserveLine(base, event);
  }
}

function firstById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

// One per id, in the order the ids first appeared, holding the content of the latest one (later `at`; the later line on a
// tie): an episode that was read again after the session grew replaces what was stored of it.
function latestById<T extends { id: string; at: string }>(items: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const item of items) {
    const known = latest.get(item.id);
    if (known === undefined || timeOf(item.at) >= timeOf(known.at)) latest.set(item.id, item);
  }
  return [...latest.values()];
}

function timeOf(iso: string): number {
  return Date.parse(iso);
}

// The state the log says at `now`. Applied in this order:
//   - duplicates by id go (a fork shares the entry ids of its parent, so a rescan finds the same episode twice); the
//     first one wins, except for an episode, where the latest wins: its end moves when the session grows. A `judged` is a
//     duplicate of another with the same episode, model and outcome;
//   - the time of an episode is when it started, and that of an observation the time of its episode (its own `at` when the
//     episode is not in the log): nothing at or before the `forget` of its skill survives, nothing older than CUTOFF_DAYS,
//     and, once the user opted in, nothing that started before optInAt -- except a note or a self-report, which the user
//     or the skill wrote on purpose and which optInAt never cuts. A forget is about what was said, so it is
//     compared with the session time and not with the moment the log learned of it: an old session scanned again after
//     the forget does not bring the skill back;
//   - proposals and tombstones are compared by their own `at` and are not subject to optInAt;
//   - what hangs from a dropped episode or proposal (its `judged`, its prompts and gate outcomes) goes with it.
// With no opt-in event there is no optInAt to cut at: the cycle writes the event before anything else, so a log without it
// holds nothing a cut could protect.
export function foldObserveState(events: readonly ObserveEvent[], now: Date): ObserveState {
  const cutoff = now.getTime() - CUTOFF_DAYS * DAY_MS;

  const optInTimes = events.filter((event) => event.type === "opt-in").map((event) => timeOf(event.at));
  const optInTime = optInTimes.length === 0 ? null : Math.min(...optInTimes);

  const forgets: Record<string, string> = {};
  for (const event of events) {
    if (event.type !== "forget") continue;
    const known = forgets[event.skill];
    if (known === undefined || timeOf(event.at) > timeOf(known)) forgets[event.skill] = event.at;
  }

  const forgotten = (skill: string, time: number): boolean => {
    const at = forgets[skill];
    return (at !== undefined && time <= timeOf(at)) || time < cutoff;
  };

  const allEpisodes = latestById(events.filter((event): event is EpisodeEvent => event.type === "episode"));
  const episodeTimes = new Map(allEpisodes.map((episode) => [episode.id, timeOf(episode.startedAt)]));

  const episodes = allEpisodes.filter((episode) => {
    const time = episodeTimes.get(episode.id) ?? timeOf(episode.at);
    return !forgotten(episode.skill, time) && (optInTime === null || time >= optInTime);
  });
  const keptEpisodes = new Set(episodes.map((episode) => episode.id));

  const observations = firstById(events.filter((event): event is ObservationEvent => event.type === "observation")).filter(
    (observation) => {
      const own = observation.episodeId === null ? undefined : episodeTimes.get(observation.episodeId);
      if (own !== undefined && !keptEpisodes.has(observation.episodeId as string)) return false;
      const time = own ?? timeOf(observation.at);
      const written = observation.source === "user-note" || observation.source === "self-report";
      return !forgotten(observation.skill, time) && (written || optInTime === null || time >= optInTime);
    },
  );

  const proposals = firstById(events.flatMap((event) => (event.type === "proposal" ? [event] : []))).filter(
    (proposal) => !forgotten(proposal.skill, timeOf(proposal.at)),
  );
  const prepareFailures = events.flatMap((event) =>
    event.type === "prepare-failed" && !forgotten(event.skill, timeOf(event.at)) ? [event] : [],
  );
  const keptProposals = new Set(proposals.map((proposal) => proposal.id));
  const droppedProposals = new Set(
    events.flatMap((event) => (event.type === "proposal" && !keptProposals.has(event.id) ? [event.id] : [])),
  );

  const judgedKeys = new Set<string>();
  const judged = events.flatMap((event) => {
    if (event.type !== "judged") return [];
    if ((episodeTimes.has(event.episodeId) && !keptEpisodes.has(event.episodeId)) || timeOf(event.at) < cutoff) return [];
    const key = JSON.stringify([event.episodeId, event.model, event.outcome]);
    if (judgedKeys.has(key)) return [];
    judgedKeys.add(key);
    return [event];
  });

  const prompts = events.flatMap((event) =>
    event.type === "prompt" && !droppedProposals.has(event.proposalId) && timeOf(event.at) >= cutoff ? [event] : [],
  );
  const gateOutcomes = events.flatMap((event) =>
    event.type === "gate-outcome" && !droppedProposals.has(event.proposalId) && timeOf(event.at) >= cutoff ? [event] : [],
  );
  const tombstones = events.flatMap((event) =>
    event.type === "tombstone" && !forgotten(event.skill, timeOf(event.at)) ? [event] : [],
  );

  return {
    optInAt: optInTime === null ? null : new Date(optInTime).toISOString(),
    episodes,
    judged,
    observations,
    proposals,
    prepareFailures,
    prompts,
    gateOutcomes,
    tombstones,
    forgets,
  };
}
