import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isExcludedCwd,
  isTopLevelSessionFile,
  listTopLevelSessionFiles,
  readSessionFile,
  sessionsRootOf,
} from "../../src/observe/session-file.ts";
import {
  cleanEpisode,
  explicitCorrection,
  fixturePath,
  groupedDirNameOf,
  makeAgentDir,
  sessionFileNameOf,
  sessionJsonl,
  writeSessionsTree,
} from "./observe-fixtures.ts";

test("sessionsRootOf: a --project-- directory is grouped and the root is its parent", () => {
  assert.deepEqual(sessionsRootOf("/home/u/.pi/agent/sessions/--work-proj-a--"), {
    root: "/home/u/.pi/agent/sessions",
    layout: "grouped",
  });
  assert.deepEqual(sessionsRootOf("/home/u/.pi/agent/sessions/--work-proj-a--/"), {
    root: "/home/u/.pi/agent/sessions",
    layout: "grouped",
  });
});

test("sessionsRootOf: any other directory is a flat root", () => {
  assert.deepEqual(sessionsRootOf("/home/u/.pi/agent/sessions"), { root: "/home/u/.pi/agent/sessions", layout: "flat" });
  assert.deepEqual(sessionsRootOf("/data/my--sessions"), { root: "/data/my--sessions", layout: "flat" });
});

test("isTopLevelSessionFile: grouped accepts <root>/<project>/<file>.jsonl and refuses nested, shallow and non-jsonl paths", () => {
  const root = { root: "/s", layout: "grouped" } as const;
  assert.equal(isTopLevelSessionFile("/s/--a--/x.jsonl", root), true);
  assert.equal(isTopLevelSessionFile("/s/--a--/run-0/session.jsonl", root), false);
  assert.equal(isTopLevelSessionFile("/s/x.jsonl", root), false);
  assert.equal(isTopLevelSessionFile("/s/--a--/x.json", root), false);
  assert.equal(isTopLevelSessionFile("/other/--a--/x.jsonl", root), false);
});

test("isTopLevelSessionFile: flat accepts <root>/<file>.jsonl and refuses anything deeper", () => {
  const root = { root: "/s", layout: "flat" } as const;
  assert.equal(isTopLevelSessionFile("/s/x.jsonl", root), true);
  assert.equal(isTopLevelSessionFile("/s/run-0/session.jsonl", root), false);
  assert.equal(isTopLevelSessionFile("/s/--a--/x.jsonl", root), false);
});

test("listTopLevelSessionFiles (grouped): lists top-level files with header id, size and mtime, never the nested run", async (t) => {
  const { sessionsDir } = makeAgentDir(t);
  const a = explicitCorrection({ id: "fx-a" });
  const b = cleanEpisode({ id: "fx-b", cwd: "/work/proj-b" });
  const nested = cleanEpisode({ id: "fx-nested" });
  const mtime = new Date("2026-11-12T10:00:00.000Z");
  const [fileA, fileB] = writeSessionsTree(sessionsDir, "grouped", [
    { spec: a, mtime },
    { spec: b },
    { spec: nested, nested: true },
  ]);

  const refs = await listTopLevelSessionFiles(sessionsRootOf(path.dirname(fileA as string)));

  assert.deepEqual(
    refs.map((ref) => [ref.path, ref.headerId]),
    [
      [fileA, "fx-a"],
      [fileB, "fx-b"],
    ],
  );
  assert.equal(refs[0]?.size, fs.statSync(fileA as string).size);
  assert.equal(refs[0]?.mtimeMs, mtime.getTime());
});

test("listTopLevelSessionFiles (flat): lists the files of the root and ignores the nested run and non-jsonl files", async (t) => {
  const { sessionsDir } = makeAgentDir(t);
  const [file] = writeSessionsTree(sessionsDir, "flat", [
    { spec: explicitCorrection({ id: "fx-flat" }) },
    { spec: cleanEpisode({ id: "fx-flat-nested" }), nested: true },
  ]);
  fs.writeFileSync(path.join(sessionsDir, "notes.txt"), "not a session");

  const refs = await listTopLevelSessionFiles({ root: sessionsDir, layout: "flat" });

  assert.deepEqual(refs.map((ref) => [ref.path, ref.headerId]), [[file, "fx-flat"]]);
});

test("listTopLevelSessionFiles: a missing root is an empty list, and a file without a complete header line is skipped", async (t) => {
  const { sessionsDir, root } = makeAgentDir(t);
  assert.deepEqual(await listTopLevelSessionFiles({ root: path.join(root, "absent"), layout: "flat" }), []);

  fs.writeFileSync(path.join(sessionsDir, "half.jsonl"), '{"type":"session","id":"fx-half"');
  fs.writeFileSync(path.join(sessionsDir, "not-a-header.jsonl"), '{"type":"message","id":"x"}\n');
  fs.writeFileSync(path.join(sessionsDir, "garbage.jsonl"), "garbage\n");
  assert.deepEqual(await listTopLevelSessionFiles({ root: sessionsDir, layout: "flat" }), []);
});

test("readSessionFile: answers the header and the entries after it, up to the end of the file", async (t) => {
  const { root } = makeAgentDir(t);
  const spec = explicitCorrection({ id: "fx-read" });
  const file = path.join(root, sessionFileNameOf(spec));
  const text = sessionJsonl(spec);
  fs.writeFileSync(file, text);

  const result = await readSessionFile(file);

  assert.ok(result.ok);
  assert.equal(result.value.header.id, "fx-read");
  assert.equal(result.value.header.cwd, spec.cwd);
  assert.equal(result.value.entries.length, spec.steps.length);
  assert.equal(result.value.endOffset, Buffer.byteLength(text));
});

test("readSessionFile: a truncated last line is left out and endOffset stops at the last newline", async (t) => {
  const { root } = makeAgentDir(t);
  const spec = explicitCorrection({ id: "fx-trunc" });
  const file = path.join(root, "trunc.jsonl");
  const text = sessionJsonl(spec, { truncateTail: true });
  fs.writeFileSync(file, text);

  const result = await readSessionFile(file);

  assert.ok(result.ok);
  assert.equal(result.value.entries.length, spec.steps.length - 1);
  assert.equal(result.value.endOffset, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
});

test("readSessionFile: a version 2 file is migrated to the current version by pi's own migration", async () => {
  const result = await readSessionFile(fixturePath("sessions", "v2-explicit.jsonl"));

  assert.ok(result.ok);
  assert.equal(result.value.header.id, "fx-v2-0001");
  assert.equal(result.value.header.version, 3);
  assert.ok(result.value.entries.length > 0);
});

test("readSessionFile: refuses a missing file, a file with no complete line and a file that does not start with a header", async (t) => {
  const { root } = makeAgentDir(t);
  const missing = await readSessionFile(path.join(root, "absent.jsonl"));
  assert.equal(missing.ok, false);

  const noLine = path.join(root, "no-line.jsonl");
  fs.writeFileSync(noLine, '{"type":"session","id":"x"');
  const noLineResult = await readSessionFile(noLine);
  assert.equal(noLineResult.ok, false);

  const noHeader = path.join(root, "no-header.jsonl");
  fs.writeFileSync(noHeader, '{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-12T09:00:00.000Z"}\n');
  const noHeaderResult = await readSessionFile(noHeader);
  assert.equal(noHeaderResult.ok, false);
  assert.match(noHeaderResult.ok ? "" : noHeaderResult.error, /no session header/);
});

test("isExcludedCwd: tmp directories, anything under them, relative or empty cwds and missing directories are excluded", () => {
  const exists = (): boolean => true;
  assert.equal(isExcludedCwd("/tmp", exists, []), true);
  assert.equal(isExcludedCwd("/tmp/scratch", exists, []), true);
  assert.equal(isExcludedCwd("/private/tmp/scratch", exists, []), true);
  assert.equal(isExcludedCwd("/var/folders/ab/T/run", exists, ["/var/folders/ab/T"]), true);
  assert.equal(isExcludedCwd("/var/folders/ab/T", exists, ["/var/folders/ab/T"]), true);
  assert.equal(isExcludedCwd("", exists, []), true);
  assert.equal(isExcludedCwd("relative/dir", exists, []), true);
  assert.equal(isExcludedCwd("/work/gone", () => false, []), true);
});

test("isExcludedCwd: an existing directory outside the tmp directories is kept, and a sibling with the same prefix is not 'under' tmp", () => {
  assert.equal(isExcludedCwd("/work/proj-a", () => true, ["/var/folders/ab/T"]), false);
  assert.equal(isExcludedCwd("/tmpfoo/proj", () => true, []), false);
  assert.equal(isExcludedCwd("/var/folders/ab/Tx", () => true, ["/var/folders/ab/T"]), false);
});

test("groupedDirNameOf output is recognised as grouped by sessionsRootOf", () => {
  assert.equal(sessionsRootOf(path.join("/s", groupedDirNameOf("/work/proj-a"))).layout, "grouped");
});
