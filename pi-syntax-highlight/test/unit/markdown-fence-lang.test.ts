import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInfoString, transformFenceLanguages } from "../../src/markdown-fence-lang.ts";

const PROSE = "This paragraph explains why the transformer runs before rendering.\nIt keeps the fence character and the body untouched.";

test("normalizeInfoString: an empty info string takes the detected language", () => {
  assert.equal(normalizeInfoString("", `{\n  "name": "pi"\n}`), "json");
  // Nothing detected and nothing declared stays empty: the fence keeps the flat
  // color instead of gaining a wrong one.
  assert.equal(normalizeInfoString("  ", PROSE), "");
});

test("normalizeInfoString: a known name or alias is returned as written", () => {
  assert.equal(normalizeInfoString("ts", "const x = 1;"), "ts");
  assert.equal(normalizeInfoString("{.ts}", "const x = 1;"), "ts");
  assert.equal(normalizeInfoString(`js title="a"`, "const x = 1;"), "js");
});

test("normalizeInfoString: a token the author wrote is returned as written, whatever the body is", () => {
  assert.equal(normalizeInfoString("foo", PROSE), "foo");
  // Detection only fills a gap: a recognizable body never overrides a label.
  assert.equal(normalizeInfoString("foo", "git clone https://example.com/repo.git\ncd repo"), "foo");
  assert.equal(normalizeInfoString("powershell", `{\n  "name": "pi"\n}`), "powershell");
});

test("an unlabeled fence gets the detected language and the text around it is copied", () => {
  const markdown = `Here is the config:\n\n\`\`\`\n{\n  "name": "pi"\n}\n\`\`\`\n\nThat is all.\n`;
  assert.equal(
    transformFenceLanguages(markdown),
    `Here is the config:\n\n\`\`\`json\n{\n  "name": "pi"\n}\n\`\`\`\n\nThat is all.\n`,
  );
});

test("a fence that already names a language is left alone", () => {
  const markdown = "```js\nconst x = 1;\n```\n";
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("an info string with attributes keeps only its language", () => {
  assert.equal(
    transformFenceLanguages(`\`\`\`js title="a"\nconst x = 1;\n\`\`\`\n`),
    "```js\nconst x = 1;\n```\n",
  );
});

test("an unknown info string survives, and the body is not detected for it", () => {
  const markdown = "```foo\ngit clone https://example.com/repo.git\ncd repo\nnpm install\n```\n";
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("an unknown info string survives when the body is prose", () => {
  const markdown = `\`\`\`foo\n${PROSE}\n\`\`\`\n`;
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("an unclosed fence is untouched", () => {
  const markdown = `\`\`\`\n{\n  "name": "pi"\n}\n`;
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("a block indented four spaces is not a fence and stays untouched", () => {
  const markdown = `    \`\`\`\n    {"name": "pi"}\n    \`\`\`\n`;
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("a tilde fence is rewritten the same way", () => {
  assert.equal(
    transformFenceLanguages(`~~~\n{\n  "name": "pi"\n}\n~~~\n`),
    `~~~json\n{\n  "name": "pi"\n}\n~~~\n`,
  );
});

test("with the last fence open only the closed one is rewritten", () => {
  const markdown = `\`\`\`\n{\n  "name": "pi"\n}\n\`\`\`\n\n\`\`\`\nconst x = 1;\n`;
  assert.equal(
    transformFenceLanguages(markdown),
    `\`\`\`json\n{\n  "name": "pi"\n}\n\`\`\`\n\n\`\`\`\nconst x = 1;\n`,
  );
});

test("a closing fence may be longer than the opening one", () => {
  assert.equal(
    transformFenceLanguages(`\`\`\`\n{\n  "name": "pi"\n}\n\`\`\`\`\`\n`),
    `\`\`\`json\n{\n  "name": "pi"\n}\n\`\`\`\`\`\n`,
  );
});

test("a pandoc attribute list naming the language is unwrapped", () => {
  assert.equal(
    transformFenceLanguages(`\`\`\`{.ts}\ninterface User {\n  id: number;\n}\n\`\`\`\n`),
    "```ts\ninterface User {\n  id: number;\n}\n```\n",
  );
});

test("the transform is idempotent", () => {
  const markdown = `Intro\n\n\`\`\`\n{\n  "name": "pi"\n}\n\`\`\`\n\n\`\`\`js title="a"\nconst x = 1;\n\`\`\`\n\n~~~foo\ngit status\n~~~\n`;
  const once = transformFenceLanguages(markdown);
  assert.notEqual(once, markdown);
  assert.equal(transformFenceLanguages(once), once);
});

test("a correctly labeled fence keeps its token even when the body would be detected", () => {
  const powershell = "```powershell\nGet-ChildItem | Where-Object { $_.Name }\n```\n";
  assert.equal(transformFenceLanguages(powershell), powershell);
});

test("a mermaid fence is left to the built-in transformer", () => {
  const markdown = "```mermaid\ngraph TD;\n  A-->B;\n```\n";
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("a mermaid fence whose body looks like JSON is still left alone", () => {
  const markdown = `\`\`\`mermaid\n{\n  "name": "pi"\n}\n\`\`\`\n`;
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("a reserved info string is compared case-insensitively", () => {
  const markdown = `\`\`\`Mermaid\n{\n  "name": "pi"\n}\n\`\`\`\n`;
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("a backtick in the info string of a backtick fence opens nothing", () => {
  const markdown = "```js``` is the info string.\n\n```js\nconst x = 1;\n```\n";
  assert.equal(transformFenceLanguages(markdown), markdown);
});

test("a tilde in the info string of a tilde fence opens nothing", () => {
  const markdown = "~~~js~~~ is the info string.\n\n~~~js\nconst x = 1;\n~~~\n";
  assert.equal(transformFenceLanguages(markdown), markdown);
});
