import { test } from "node:test";
import assert from "node:assert/strict";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { createMarkdownTransformer } from "../../src/markdown-fence-lang.ts";

initTheme("system");

const WIDTH = 100;

// One transformer for the whole file, like the extension registers: the memo is the
// only state it has and every render below goes through it.
const transformer = createMarkdownTransformer();

function transform(markdown: string): string {
  return transformer(markdown, { messageType: "assistant", isStreaming: false, availableWidth: WIDTH });
}

// The markdown component the assistant message builds: no padding, no default text
// style, and the transformer only on the transformed side.
function renderLines(markdown: string, transformed: boolean): string[] {
  const options = transformed ? { transform } : undefined;
  return new Markdown(markdown, 0, 0, getMarkdownTheme(), undefined, options).render(WIDTH);
}

// Every fence is labeled on purpose: an unlabeled one is relabeled, which is a
// visible change this contract does not cover.
const CORPUS: ReadonlyArray<{ name: string; markdown: string }> = [
  {
    name: "headings",
    markdown: "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n",
  },
  { name: "quotes", markdown: "> quoted text\n>\n> > nested quote\n> second line\n" },
  { name: "quote with a list item", markdown: "> - item\n> - other\n" },
  { name: "quote with an ordered item", markdown: "> 1. first\n> 2. second\n" },
  { name: "quote with a table", markdown: "> | t |\n> | --- |\n> | a |\n" },
  { name: "lists", markdown: "- one\n- two with `code`\n  - nested\n\n1. first\n2. second\n" },
  { name: "table", markdown: "| key | value |\n| --- | --- |\n| a | `b` |\n" },
  { name: "inline styles", markdown: "Some **bold**, *italic*, ~~struck~~ and `code` in one line.\n" },
  { name: "links", markdown: "See [the docs](https://example.com) and the [other `one`](https://example.org).\n" },
  { name: "dunder code span", markdown: "Call `__init__` first.\n" },
  { name: "emphasis lookalike code span", markdown: "The product `a*b*c` is literal.\n" },
  { name: "html code span", markdown: "Use `<div>` here.\n" },
  { name: "js fence", markdown: "```js\nconst x = 1;\n```\n" },
  { name: "mermaid fence", markdown: "```mermaid\ngraph TD;\n  A-->B;\n```\n" },
  { name: "math fence", markdown: "```math\nx^2 + y^2\n```\n" },
  { name: "inline math", markdown: "The value $x^2$ stays inline.\n" },
  {
    name: "code spans in every context",
    markdown: "# Heading with `code`\n\n> quote with `code`\n\n- item with `code`\n\nText with `code` and `--flag`.\n",
  },
  { name: "fence with attributes", markdown: '```js title="a"\nconst x = 1;\n```\n' },
  { name: "fence with attribute list", markdown: "```{.ts}\ninterface User {\n  id: number;\n}\n```\n" },
  { name: "unlabeled prose fence", markdown: "```\nThis paragraph explains why nothing is detected here.\nIt is plain prose.\n```\n" },
];

test("prose renders byte-identical with and without the transformer", () => {
  for (const item of CORPUS) {
    assert.deepEqual(renderLines(item.markdown, true), renderLines(item.markdown, false), item.name);
  }
});

test("a fence with attributes or an attribute list stays exactly as written", () => {
  assert.equal(transform('```js title="a"\nconst x = 1;\n```\n'), '```js title="a"\nconst x = 1;\n```\n');
  assert.equal(transform("```{.ts}\ninterface User {\n  id: number;\n}\n```\n"), "```{.ts}\ninterface User {\n  id: number;\n}\n```\n");
});

test("an unlabeled closed fence is labeled only when detection is confident", () => {
  assert.equal(transform('```\n{\n  "name": "pi"\n}\n```\n'), '```json\n{\n  "name": "pi"\n}\n```\n');
  const prose = "```\nThis paragraph explains why nothing is detected here.\nIt is plain prose.\n```\n";
  assert.equal(transform(prose), prose);
});
