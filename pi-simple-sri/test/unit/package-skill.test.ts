import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { caseBankReason, loadCaseBank } from "../../src/case-bank.ts";
import type { CaseBankProfile } from "../../src/case-bank.ts";
import type { GateAbstentionReason, GateVerdictReason } from "../../src/gate/types.ts";
import { PUBLISHED_SKILL_NAME } from "../../src/names.ts";
import { findSkill, listSkills } from "../../src/skills-inventory.ts";
import type { SkillImproveAction, SkillImproveOutcome } from "../../src/tool-skill-improve.ts";
import { isPlainObject } from "../../src/values.ts";
import { validateAgainstBankSchema } from "./schema-reader.ts";

// M2c, S2: the skill this package publishes. The package ships its own manual, and everything that makes it a
// skill is a fact of two files -- `pi.skills` in package.json decides that pi discovers it, `files` decides that it
// travels in the tarball -- plus the two templates of assets/ and the frontmatter that routes it.
//
// S2c splits the manual in two files: SKILL.md keeps the loop and references/case-bank.md holds the bank. The suite
// reads both, because what a reader of the installed package can follow is a fact of the pair and not of one file.
//
// The suite is the inventory, not the prose: it asserts the names the manual has to teach and the files that have
// to ship, and never the content of a sentence, so a rewrite of the manual does not break it. The two templates are
// read through the same two readers the gate uses -- src/case-bank.ts and schemas/case-bank.schema.json -- because
// an example the package cannot read is an example that teaches a format nobody can use.
//
// What the suite cannot check by running it is what the manual says about cost and about measurement: the numbers
// are asserted to be present only as the action names, and whether the prose answers "what does a gate cost" is a
// question for a session with the skill loaded.

// S2c, bandera 4: the name has one owner since S2b (src/names.ts), and the rule that refuses this manual reads it
// from there, so a literal written here could diverge from the rule without anything noticing.
const SKILL_NAME = PUBLISHED_SKILL_NAME;

// Two levels up from test/unit, the same way test/unit/schema-reader.ts reaches schemas/. The suite reads the
// package as it is on disk and not as it is installed, because what it checks is the shape that gets published.
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST_FILE = path.join(PACKAGE_ROOT, "package.json");
const SKILL_DIR = path.join(PACKAGE_ROOT, "skills", SKILL_NAME);
const SKILL_FILE = path.join(SKILL_DIR, "SKILL.md");
const ASSETS_DIR = path.join(SKILL_DIR, "assets");
// The second half of the manual (S2c): the shape of the bank, the checks of a draft and the interview that writes it
// with the user. It sits one directory deeper than SKILL.md, which is why the paths it cites are resolved from it.
const REFERENCES_DIR = path.join(SKILL_DIR, "references");
const CASE_BANK_REFERENCE = path.join(REFERENCES_DIR, "case-bank.md");
// How SKILL.md has to name the reference for a reader to find it: the path relative to the file that points.
const REFERENCE_POINTER = "references/case-bank.md";

// The four names the manual has to teach, one key per member of the union: a fifth action stops compiling here
// instead of reaching the manual unnoticed, which is what makes this table a guard against the union growing. What
// is asserted of the manual is the presence of the word and never a judgement about the sentence it appears in.
const ACTION_NAMES: Record<SkillImproveAction, string> = {
  diagnose: "diagnose",
  propose: "propose",
  gate: "gate",
  validate: "validate",
};

// The outcome vocabulary, one key per member of the union, for the same reason as the actions: every answer of a call
// carries an outcome, and an outcome the manual never names is one the reader cannot act on. What is asserted is the
// presence of the word, and this table is what makes a member added to src/tool-skill-improve.ts stop compiling here.
const OUTCOME_NAMES: Record<SkillImproveOutcome, string> = {
  diagnosed: "diagnosed",
  proposed: "proposed",
  "not-eligible": "not-eligible",
  "no-evidence": "no-evidence",
  "unknown-skill": "unknown-skill",
  "no-model": "no-model",
  "gate-accepted": "gate-accepted",
  "gate-rejected": "gate-rejected",
  "gate-abstained": "gate-abstained",
  "no-baseline": "no-baseline",
  "bank-valid": "bank-valid",
  "bank-refused": "bank-refused",
  error: "error",
};

// The abstention vocabulary, one key per member of the union: the manual tells the model that a `gate-abstained`
// names which one stopped the gate, so a reason added to src/gate/types.ts without a line in the manual is a reason
// the reader cannot recognise. What is asserted is the presence of the word, never the sentence around it.
const ABSTENTION_REASONS: Record<GateAbstentionReason, string> = {
  "insufficient-items": "insufficient-items",
  "no-improvement": "no-improvement",
  "invalid-run": "invalid-run",
  interrupted: "interrupted",
  "no-model": "no-model",
  "skill-unavailable": "skill-unavailable",
  "overlay-failed": "overlay-failed",
  "candidate-mismatch": "candidate-mismatch",
  "judge-unavailable": "judge-unavailable",
  "origin-moved": "origin-moved",
};

// The verdict vocabulary of the row `gate-rejected`, one key per member of the union: a reason added to
// src/gate/types.ts without a line in the manual is a reason the reader cannot tell apart from a rejection it already
// knows, and the row is where the manual promises the two words the reader will meet. The union is a narrowing of the
// abstention one, so the three reasons it borrows are keys here as well, and a `Record` over the union is what makes a
// member added upstream stop compiling here instead of reaching the manual unnoticed. What is asserted is the presence
// of the word, never the sentence around it.
const VERDICT_REASONS: Record<GateVerdictReason, string> = {
  "below-threshold": "below-threshold",
  "judge-failed": "judge-failed",
  "no-improvement": "no-improvement",
  "invalid-run": "invalid-run",
  interrupted: "interrupted",
};

// The names neither file of the manual may carry: a reference the reader cannot follow from inside the installed
// package (the human document it would be a second copy of), and the packages and agents of this author's
// environment, which a reader of another installation does not have. It is the same list the risk of a manual
// written from memory names, and since S2c it is swept over both files: a literal forbidden in SKILL.md is
// forbidden in the reference too.
const FORBIDDEN_IN_MANUAL: readonly string[] = ["README.md", "pablo-", "goal-discovery", "mattpocock", "scout"];

interface Template {
  file: string;
  profile: CaseBankProfile;
  // The other profile of the same format: the file read under it is a bank the reader refuses, because the profile
  // and the fields are tied to each other by src/case-bank.ts and by nothing the file itself declares.
  other: CaseBankProfile;
}

const TEMPLATES: readonly Template[] = [
  { file: "case-bank.baseline.json", profile: "baseline", other: "origin" },
  { file: "case-bank.origin.json", profile: "origin", other: "baseline" },
];

// The four files the reference cites (S2c), spelled from the directory it sits in and not from the package root: two
// templates, the schema of the format and the reader on the other side of the package. A path that reads well as prose
// and points at nothing is the defect a split introduces, and it is invisible to a reader who does not open the file.
const REFERENCE_PATHS: readonly string[] = [
  "../assets/case-bank.baseline.json",
  "../assets/case-bank.origin.json",
  "../../../schemas/case-bank.schema.json",
  "../../../src/case-bank.ts",
];

interface SkillTree {
  cwd: string;
  agentDir: string;
  skillsDir: string;
}

// os.tmpdir() is a symlink on some platforms (macOS /var -> /private/var), so the temp root is resolved once, the
// pattern test/unit/skills-inventory.test.ts uses: only the symlinks a test creates are then reported as symlinks.
function createTree(t: TestContext): SkillTree {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-package-skill-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const cwd = path.join(root, "cwd");
  const agentDir = path.join(root, "agent");
  const skillsDir = path.join(agentDir, "skills");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  return { cwd, agentDir, skillsDir };
}

function readManifest(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  if (!isPlainObject(parsed)) assert.fail(`${MANIFEST_FILE} is not a JSON object`);
  return parsed;
}

// The entries of a list field of package.json, as strings: an entry of another kind is dropped instead of being
// read as a path it does not spell.
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function declaredSkills(): string[] {
  const piBlock = readManifest().pi;
  return isPlainObject(piBlock) ? stringList(piBlock.skills) : [];
}

function manualText(): string {
  return fs.readFileSync(SKILL_FILE, "utf8");
}

// The other half of the manual (S2c), read the same way: the file as it is on disk and as it is published.
function referenceText(): string {
  return fs.readFileSync(CASE_BANK_REFERENCE, "utf8");
}

interface ManualFile {
  file: string;
  text: string;
}

// Both files are one manual, so the searches that are about what a reader can follow run over the pair and not over
// the file that happens to hold the sentence today.
function manualFiles(): ManualFile[] {
  return [
    { file: SKILL_FILE, text: manualText() },
    { file: CASE_BANK_REFERENCE, text: referenceText() },
  ];
}

interface Declaration {
  name: unknown;
  description: unknown;
  body: string;
}

// The frontmatter read with pi's own parser, which is the one that decides whether the manual routes at all: a
// hand-rolled reader here would agree with this file and disagree with the loader that has to find it.
function declaration(): Declaration {
  const parsed = parseFrontmatter(manualText());
  return { name: parsed.frontmatter.name, description: parsed.frontmatter.description, body: parsed.body };
}

function manualBody(): string {
  return declaration().body;
}

// The manual is published by this package, so the first thing to prove is that pi will discover it: `pi.skills` in
// the manifest is the declaration the loader reads, and a package with a pi block declares its resources explicitly.
test("package.json: the pi block declares ./skills", () => {
  const skills = declaredSkills();

  assert.ok(
    skills.includes("./skills"),
    `expected "pi".skills to declare ./skills, got ${JSON.stringify(skills)}`,
  );
});

// The tarball carries what `files` lists and nothing else, so a skill directory that is not listed is a manual
// installed from a package that does not hold it.
test("package.json: files covers the skills directory", () => {
  const files = stringList(readManifest().files);

  const covered = files.some((entry) => entry === "skills" || entry.startsWith("skills/"));
  assert.ok(covered, `expected "files" to carry the skills directory, got ${JSON.stringify(files)}`);
});

// The frontmatter is the whole of what the manual contributes to the system prompt of every session: the name the
// model loads it by, and the description that decides whether it is loaded at all.
test("SKILL.md: the frontmatter parses and declares the name and a description", () => {
  const declared = declaration();

  assert.equal(declared.name, SKILL_NAME);

  const description = declared.description;
  if (typeof description !== "string") {
    assert.fail(`expected a string description in ${SKILL_FILE}, got ${JSON.stringify(description)}`);
  }
  assert.notEqual(description.trim(), "", "expected a non-empty description: pi drops a skill it cannot route");
  assert.notEqual(declared.body.trim(), "", "expected a body after the frontmatter, not a bare declaration");
});

// The manual copied into a temporary agent directory is the only way to ask pi's loader what it makes of it without
// depending on what this machine has installed: listSkills builds its own loader, so the working directory stays
// empty and the only skill that can appear is the one the test put there.
test("listSkills: pi discovers the manual as a declared skill with its own description", async (t) => {
  const tree = createTree(t);
  fs.cpSync(SKILL_DIR, path.join(tree.skillsDir, SKILL_NAME), { recursive: true });

  const skills = await listSkills({ cwd: tree.cwd, agentDir: tree.agentDir });
  const skill = findSkill(skills, SKILL_NAME);

  assert.ok(skill, `expected ${SKILL_NAME} in ${JSON.stringify(skills.map((entry) => entry.name))}`);
  assert.equal(skill.kind, "declared");
  assert.equal(skill.name, SKILL_NAME);
  assert.equal(skill.description, declaration().description);
});

// OA9: the union of the four actions is the vocabulary the manual teaches, and a manual that named three of them
// would be a manual whose fourth action is only discoverable by reading the schema of the tool. S2c makes the search
// run over the two files, and SKILL.md keeps the guarantee it always had: it is the file that routes and prices the
// four actions, so a reference that named one of them would not make up for a manual that does not.
test("SKILL.md and references/case-bank.md: the manual names every action of the tool", () => {
  const manual = manualFiles();
  const body = manualBody();

  for (const name of Object.values(ACTION_NAMES)) {
    assert.ok(
      manual.some((entry) => entry.text.includes(name)),
      `expected the manual to name the action ${JSON.stringify(name)}`,
    );
    assert.ok(body.includes(name), `expected SKILL.md to name the action ${JSON.stringify(name)}`);
  }
});

// The other closed vocabulary of the tool, for the same reason as the abstention reasons: a call answers with an
// outcome, and an outcome the manual never names leaves the reader unable to say whether a retry, a correction of the
// bank or a stop is next.
test("SKILL.md: the manual names every outcome of a call", () => {
  const body = manualBody();

  for (const name of Object.values(OUTCOME_NAMES)) {
    assert.ok(body.includes(name), `expected the manual to name the outcome ${JSON.stringify(name)}`);
  }
});

// The other closed vocabulary the manual quotes in full, for the same reason: a reader that meets an abstention it
// has never been told about cannot say whether to retry, fix the bank or stop.
test("SKILL.md: the manual names every reason a gate abstains for", () => {
  const body = manualBody();

  for (const reason of Object.values(ABSTENTION_REASONS)) {
    assert.ok(body.includes(reason), `expected the manual to name the abstention reason ${JSON.stringify(reason)}`);
  }
});

// The verdict vocabulary, for the same reason as the abstention one and over its own union: the row `gate-rejected` of
// the manual spells the reason a rejection carries, so a reason the reader has never been told about is a rejection it
// cannot tell from a defect of the run. The three reasons this union borrows from the abstention one are asserted by
// both tests, which costs nothing and keeps each table total over its own type.
test("SKILL.md: the manual names every reason the verdict of a gate carries", () => {
  const body = manualBody();

  for (const reason of Object.values(VERDICT_REASONS)) {
    assert.ok(body.includes(reason), `expected the manual to name the verdict reason ${JSON.stringify(reason)}`);
  }
});

// The templates are the only worked example of the format, and they are read by both readers the gate reads a bank
// with: the schema declares the limits of every field, src/case-bank.ts is the authority on which profile accepts
// which fields, and a template that fails either one teaches a bank the package would refuse.
test("assets/: each template is valid under its own profile and refused under the other", async () => {
  for (const template of TEMPLATES) {
    const file = path.join(ASSETS_DIR, template.file);
    const document: unknown = JSON.parse(fs.readFileSync(file, "utf8"));

    assert.deepEqual(validateAgainstBankSchema(document), [], `${template.file} violates the bank schema`);

    const loaded = await loadCaseBank(file, template.profile);
    if (!loaded.ok) {
      assert.fail(`${template.file} is not a bank of profile ${template.profile}: ${caseBankReason(loaded.error)}`);
    }

    const wrongProfile = await loadCaseBank(file, template.other);
    if (wrongProfile.ok) {
      assert.fail(`${template.file} was read as a bank of profile ${template.other}`);
    }
    assert.match(caseBankReason(wrongProfile.error), /^bank-invalid: /);
  }
});

// The manual travels to every installation, and a sentence of it that points at a file of this repository, or at a
// package or an agent of this author's machine, is a pointer a reader cannot follow. Both files travel, so both are
// swept.
test("SKILL.md and references/case-bank.md: the manual names no other document, package or agent", () => {
  for (const entry of manualFiles()) {
    for (const name of FORBIDDEN_IN_MANUAL) {
      assert.equal(
        entry.text.includes(name),
        false,
        `expected ${path.basename(entry.file)} not to name ${JSON.stringify(name)}`,
      );
    }
  }
});

// The manual has two files since S2c (the decision of the slice), so the pointer is half of what makes the second one
// reachable: a SKILL.md that never names it is a section closed by a path nobody wrote, and a reference that lost its
// content is a pointer to nothing. `files` in package.json lists `skills` whole, so the directory ships with it.
test("references/case-bank.md: the reference exists and SKILL.md points at it", () => {
  const reference = referenceText();

  assert.notEqual(reference.trim(), "", `expected ${CASE_BANK_REFERENCE} to hold the bank SKILL.md points at`);
  assert.ok(
    manualText().includes(REFERENCE_POINTER),
    `expected SKILL.md to name ${JSON.stringify(REFERENCE_POINTER)}`,
  );
});

// The paths above are resolved from the directory the reference sits in, which is one level deeper than the skill,
// and each one has to be a file on disk.
test("references/case-bank.md: the paths it cites resolve from the file that cites them", () => {
  const text = referenceText();

  for (const cited of REFERENCE_PATHS) {
    assert.ok(text.includes(cited), `expected the reference to cite ${JSON.stringify(cited)}`);

    const resolved = path.resolve(REFERENCES_DIR, cited);
    assert.ok(fs.existsSync(resolved), `expected ${cited} to resolve to a file, got ${resolved}`);
    assert.ok(fs.statSync(resolved).isFile(), `expected ${cited} to resolve to a regular file, got ${resolved}`);
  }
});
