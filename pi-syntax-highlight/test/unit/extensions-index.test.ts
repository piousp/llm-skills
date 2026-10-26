import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
  MarkdownTransformer,
  SessionStartEvent,
  Theme,
  ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import piSyntaxHighlight from "../../extensions/index.ts";
import { activeTheme, resetActiveTheme } from "../../src/active-theme.ts";
import { resolveToolRenderers } from "../../src/resolve-renderers.ts";

const ACCENT = "\x1b[38;5;5m";

// The host's `Theme` cannot be constructed outside a session, so the fake supplies
// the only two members the markdown pass reads, with the accent a colored theme
// would give it.
function fakeTheme(): Theme {
  const ansi: Record<string, string> = { accent: ACCENT, mdQuote: "\x1b[39m\x1b[2m" };
  return {
    getFgAnsi: (color: string) => ansi[color] ?? "",
    getBgAnsi: () => "",
  } as unknown as Theme;
}

function fakeContext(theme: Theme): ExtensionContext {
  return { ui: { theme } } as unknown as ExtensionContext;
}

// The factory takes the host's `ExtensionAPI`, which carries dozens of members.
// This fake declares exactly the three registrations E1 makes; `ExtensionAPI` is a
// superset of it, so the fake narrows to it without going through `any`.
interface FakePi {
  registerToolRenderer(resolver: ToolRendererResolver): void;
  registerMarkdownTransformer(transformer: MarkdownTransformer): void;
  on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => void): () => void;
}

function loadExtension(): {
  renderers: ToolRendererResolver[];
  transformers: MarkdownTransformer[];
  sessionStart: Array<(event: SessionStartEvent, ctx: ExtensionContext) => void>;
} {
  const renderers: ToolRendererResolver[] = [];
  const transformers: MarkdownTransformer[] = [];
  const sessionStart: Array<(event: SessionStartEvent, ctx: ExtensionContext) => void> = [];
  const fakePi: FakePi = {
    registerToolRenderer: (resolver) => {
      renderers.push(resolver);
    },
    registerMarkdownTransformer: (transformer) => {
      transformers.push(transformer);
    },
    on: (_event, handler) => {
      sessionStart.push(handler);
      return () => {};
    },
  };
  piSyntaxHighlight(fakePi as ExtensionAPI);
  return { renderers, transformers, sessionStart };
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

test("the extension registers exactly one session_start handler", () => {
  const { sessionStart } = loadExtension();
  assert.equal(sessionStart.length, 1);
});

test("the session_start handler captures the theme the context hands out", () => {
  resetActiveTheme();
  const { sessionStart } = loadExtension();
  const theme = fakeTheme();
  sessionStart[0]?.({ type: "session_start", reason: "startup" }, fakeContext(theme));
  assert.equal(activeTheme(), theme);
  resetActiveTheme();
});

test("without a captured theme the transformer adds no sequence", () => {
  resetActiveTheme();
  const { transformers } = loadExtension();
  const markdown = "# Title\n\n> quoted\n";
  assert.equal(transformers[0](markdown, { messageType: "assistant", isStreaming: false, availableWidth: 80 }), markdown);
});

test("with a captured theme the transformer styles the assistant message", () => {
  resetActiveTheme();
  const { transformers, sessionStart } = loadExtension();
  sessionStart[0]?.({ type: "session_start", reason: "startup" }, fakeContext(fakeTheme()));
  const styled = transformers[0]("# Title\n", { messageType: "assistant", isStreaming: false, availableWidth: 80 });
  // The capture is the only thing that changed between this and the previous case.
  assert.ok(styled.includes(ACCENT));
  resetActiveTheme();
});
