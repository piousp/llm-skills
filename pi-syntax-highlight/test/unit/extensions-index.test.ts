import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  MarkdownTransformer,
  MarkdownTransformerOptions,
  ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import piSyntaxHighlight from "../../extensions/index.ts";
import { resolveToolRenderers } from "../../src/resolve-renderers.ts";

// The factory takes the host's `ExtensionAPI`, which carries dozens of members.
// This fake declares exactly the two registrations the extension makes;
// `ExtensionAPI` is a superset of it, so the fake narrows to it without going through `any`.
interface FakePi {
  registerToolRenderer(resolver: ToolRendererResolver): void;
  registerMarkdownTransformer(transformer: MarkdownTransformer, options?: MarkdownTransformerOptions): void;
}

function loadExtension(): {
  renderers: ToolRendererResolver[];
  transformers: MarkdownTransformer[];
  transformerOptions: Array<MarkdownTransformerOptions | undefined>;
} {
  const renderers: ToolRendererResolver[] = [];
  const transformers: MarkdownTransformer[] = [];
  const transformerOptions: Array<MarkdownTransformerOptions | undefined> = [];
  const fakePi: FakePi = {
    registerToolRenderer: (resolver) => {
      renderers.push(resolver);
    },
    registerMarkdownTransformer: (transformer, options) => {
      transformers.push(transformer);
      transformerOptions.push(options);
    },
  };
  piSyntaxHighlight(fakePi as ExtensionAPI);
  return { renderers, transformers, transformerOptions };
}

test("the extension registers exactly one tool renderer and one markdown transformer", () => {
  const { renderers, transformers } = loadExtension();
  assert.equal(renderers.length, 1);
  assert.equal(transformers.length, 1);
  assert.equal(renderers[0], resolveToolRenderers);
});

test("the markdown transformer labels a fence that arrives without a language", () => {
  const { transformers } = loadExtension();
  const markdown = "```\n{\n  \"name\": \"pi\"\n}\n```\n";
  assert.equal(
    transformers[0](markdown, { messageType: "assistant", isStreaming: false, availableWidth: 80 }),
    "```json\n{\n  \"name\": \"pi\"\n}\n```\n",
  );
});

test("the markdown transformer leaves a fence that already names a language alone", () => {
  const { transformers } = loadExtension();
  const markdown = "# Title\n\n```ts\nconst x = 1;\n```\n";
  assert.equal(transformers[0](markdown, { messageType: "assistant", isStreaming: false, availableWidth: 80 }), markdown);
});

test("the markdown transformer is registered for user, assistant, thinking, custom and summary messages", () => {
  const { transformerOptions } = loadExtension();
  assert.deepEqual(transformerOptions, [{ messageTypes: ["user", "assistant", "assistant-thinking", "custom", "summary"] }]);
});
