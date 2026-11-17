import path from "node:path";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { textOf } from "../evidence.ts";
import { PUBLISHED_SKILL_NAME, SKILL_FILE } from "../names.ts";
import { splitSkillBlock } from "../skill-block.ts";
import type { SkillRef } from "../types.ts";
import { EPISODE_USER_MESSAGE_CAP, observeId, type Episode, type EpisodeAttribution, type SessionRead } from "./types.ts";

// Cuts a session into episodes: one run of one skill, from the moment it was invoked to the next invocation, the end
// of the file or the cap of user messages. An episode is a set of pointers into the file, never content.
//
//   explicit  the user message that carries the skill's <skill> block (/skill:x).
//   implicit  an assistant `read` of the skill's SKILL.md. It starts at that entry, and the user message before it
//             is the first anchor: it is what the user asked for.
//
// The file is read in the order it was appended; the tree of a branched session is not followed.

const READ_TOOL = "read";
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
// A turn that reads more SKILL.md files than this is looking for a skill, not using one.
const MAX_SKILL_READS_PER_TURN = 2;

interface Open {
  skill: string;
  attribution: EpisodeAttribution;
  startIndex: number;
  anchors: string[];
}

interface Closed extends Open {
  endIndex: number;
}

interface ToolCall {
  name: string;
  path: string | undefined;
}

function messageOf(entry: FileEntry): { role?: unknown; content?: unknown } | undefined {
  if (entry.type !== "message") return undefined;
  return entry.message as unknown as { role?: unknown; content?: unknown };
}

function userTextOf(entry: FileEntry): string | undefined {
  const message = messageOf(entry);
  if (message?.role !== "user") return undefined;
  const content = message.content;
  return typeof content === "string" || Array.isArray(content) ? textOf(content as Parameters<typeof textOf>[0]) : "";
}

function toolCallsOf(entry: FileEntry): ToolCall[] {
  const message = messageOf(entry);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: ToolCall[] = [];
  for (const part of message.content as { type?: unknown; name?: unknown; arguments?: unknown }[]) {
    if (part.type !== "toolCall" || typeof part.name !== "string") continue;
    const args = part.arguments as { path?: unknown } | undefined;
    calls.push({ name: part.name, path: typeof args?.path === "string" ? args.path : undefined });
  }
  return calls;
}

function providerOf(entry: FileEntry): string | undefined {
  const message = messageOf(entry) as { role?: unknown; provider?: unknown } | undefined;
  return message?.role === "assistant" && typeof message.provider === "string" ? message.provider : undefined;
}

function skillFilesOf(skill: SkillRef): string[] {
  return [...new Set([path.join(skill.dir, SKILL_FILE), path.join(skill.realDir, SKILL_FILE)])];
}

// The text a user typed, in the order of the file: `user` role only (steering included), the <skill> block stripped.
// A message that is only a block, or only images, holds nothing the user wrote and is left out.
export function userAuthoredTurns(entries: readonly FileEntry[]): { anchorEntryId: string; text: string }[] {
  const turns: { anchorEntryId: string; text: string }[] = [];
  for (const entry of entries) {
    const raw = userTextOf(entry);
    if (raw === undefined || entry.type === "session") continue;
    const { userText } = splitSkillBlock(raw);
    if (userText.trim() !== "") turns.push({ anchorEntryId: entry.id, text: userText });
  }
  return turns;
}

// `skills` is the inventory (implicit episodes are recognised by its SKILL.md paths); `observable` answers whether
// the skill may be observed at all (the settings' allow/deny). The skill this package publishes never is.
export function segmentEpisodes(
  read: SessionRead,
  file: { path: string },
  skills: readonly SkillRef[],
  observable: (skillName: string) => boolean,
): Episode[] {
  const { header, entries } = read;
  const isObservable = (name: string): boolean => name !== PUBLISHED_SKILL_NAME && observable(name);
  const skillByFile = new Map<string, SkillRef>();
  for (const skill of skills) for (const target of skillFilesOf(skill)) skillByFile.set(target, skill);
  const resolve = (target: string): string => path.resolve(header.cwd, target);

  const closed: Closed[] = [];
  let open: Open | undefined;
  let lastUserId: string | undefined;

  const close = (endIndex: number): void => {
    if (open !== undefined) closed.push({ ...open, endIndex });
    open = undefined;
  };

  entries.forEach((entry, index) => {
    const userText = userTextOf(entry);
    if (userText !== undefined) {
      lastUserId = entry.id;
      const block = splitSkillBlock(userText).skill;
      if (block !== null) {
        close(index - 1);
        if (isObservable(block.name)) open = { skill: block.name, attribution: "explicit", startIndex: index, anchors: [entry.id] };
      } else if (open !== undefined) {
        if (open.anchors.length >= EPISODE_USER_MESSAGE_CAP) close(index - 1);
        else open.anchors.push(entry.id);
      }
      return;
    }

    const reads = toolCallsOf(entry).filter((call) => call.name === READ_TOOL && call.path !== undefined && path.basename(call.path) === SKILL_FILE);
    if (reads.length === 0 || reads.length > MAX_SKILL_READS_PER_TURN) return;
    for (const call of reads) {
      const skill = skillByFile.get(resolve(call.path as string));
      if (skill === undefined || !isObservable(skill.name)) continue;
      if (open?.skill === skill.name) return;
      close(index - 1);
      open = { skill: skill.name, attribution: "implicit", startIndex: index, anchors: lastUserId === undefined ? [] : [lastUserId] };
      return;
    }
  });
  close(entries.length - 1);

  const episodes: Episode[] = [];
  for (const span of closed) {
    const range = entries.slice(span.startIndex, span.endIndex + 1);
    if (span.attribution === "implicit" && editsSkillFile(range, skills.find((skill) => skill.name === span.skill), resolve)) continue;
    const start = range[0] as FileEntry & { id: string; timestamp: string };
    const end = range[range.length - 1] as FileEntry & { id: string };
    episodes.push({
      id: observeId("ep", [span.skill, start.id]),
      skill: span.skill,
      sessionId: header.id,
      sessionFile: file.path,
      cwd: header.cwd,
      startEntryId: start.id,
      endEntryId: end.id,
      anchorEntryIds: span.anchors,
      startedAt: start.timestamp,
      attribution: span.attribution,
      providers: [...new Set(range.flatMap((entry) => providerOf(entry) ?? []))],
    });
  }
  return episodes;
}

// The user was editing the skill, not using it.
function editsSkillFile(range: readonly FileEntry[], skill: SkillRef | undefined, resolve: (target: string) => string): boolean {
  if (skill === undefined) return false;
  const files = new Set(skillFilesOf(skill));
  return range.some((entry) => toolCallsOf(entry).some((call) => EDIT_TOOLS.has(call.name) && call.path !== undefined && files.has(resolve(call.path))));
}
