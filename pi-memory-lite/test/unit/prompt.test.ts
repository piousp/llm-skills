import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_PROMPT_SECTION, memoryPromptSectionFor, type MemoryPromptInput } from "../../src/prompt.ts";
import { MEMORY_TOOL_NAMES } from "../../src/tools.ts";

// The conditional section, as the pure function it is: two lists in, one section or nothing out, and no session
// involved. The exact texts are the contract here — the model reads them, and DEVELOPER.md quotes their lengths — which
// is why the tests of the three mechanisms spell them out whole instead of matching fragments.

/** The four names as the prompts name them, in the order `MEMORY_TOOL_NAMES` fixes. */
const ALL = [...MEMORY_TOOL_NAMES];

/** The host's `tool_search`, which finds a tool and keeps it declared for the rest of the session. */
const TOOL_SEARCH = "tool_search";

/** The host's `codemode`, whose scripts call any registered tool by name. */
const CODEMODE = "codemode";

/**
 * The input of a session that declares the four, which is the state the default exposure leaves. The registry holds them
 * too: the default state of a session is that the four declarations exist and are in the prompt, and every test that is
 * about another branch overrides only what that branch reads.
 */
function input(overrides: Partial<MemoryPromptInput> = {}): MemoryPromptInput {
  return { selectedTools: [...ALL], hiddenTools: [], exposure: "direct", registeredTools: [...ALL], ...overrides };
}

// The default exposure: the four declarations are in `<tools>` already, so the section would repeat the prompt.
test("prompt: las cuatro declaradas no aportan sección", () => {
  assert.equal(memoryPromptSectionFor(input()), undefined);
  // Ni con otras tools declaradas al lado: lo que importa es que las cuatro estén, no que sean las únicas.
  assert.equal(memoryPromptSectionFor(input({ selectedTools: ["read", "bash", ...ALL] })), undefined);
});

// The `prepareLoadout` case: a declaration the requests leave out is not declared for the model, even though the host
// lists it as selected. One name hidden is one name missing, and the section names only that one.
test("prompt: una tool declarada y oculta cuenta como no declarada", () => {
  const section = memoryPromptSectionFor(
    input({ selectedTools: [...ALL, TOOL_SEARCH], hiddenTools: ["memory_write"], exposure: "codemode" }),
  );

  assert.equal(section?.kind, "tool_search");
  assert.equal(section?.text.includes("memory_write"), true, `la sección tiene que nombrar memory_write; llegó: ${section?.text}`);
  for (const other of ALL.slice(1)) {
    assert.equal(section?.text.includes(other), false, `la sección no puede nombrar ${other}, que sí está declarada`);
  }
});

// §8.6: con una exposición que sacó las declaraciones y `tool_search` declarado, la sección nombra la búsqueda, y el
// texto es la cadena que el modelo lee.
test("prompt: sin las tools y con tool_search la sección nombra la búsqueda", () => {
  const section = memoryPromptSectionFor(
    input({ selectedTools: ["read", "bash", TOOL_SEARCH], exposure: "codemode" }),
  );

  assert.deepEqual(section, {
    kind: "tool_search",
    text: "Memory tools are installed but not declared in this prompt: memory_write, memory_search, memory_read and memory_delete. Find them with tool_search; a match stays declared for the rest of the session.",
  });
});

// §8.6: con `codemode` activo la sección nombra el script y las dos formas de encontrar las tools desde él.
test("prompt: sin las tools y con codemode la sección nombra el script", () => {
  const section = memoryPromptSectionFor(input({ selectedTools: ["read", "bash", CODEMODE] }));

  assert.deepEqual(section, {
    kind: "codemode",
    text: 'Memory tools are installed but not declared in this prompt: memory_write, memory_search, memory_read and memory_delete. Call them from a codemode script: searchTools("memory") returns them and ALL_TOOLS lists all callable tools.',
  });
});

// The case the package cannot repair: neither mechanism is declared, so the section says the tools are unreachable and
// names the ways out, the allowlist among them. "Never silently unusable" is this sentence.
test("prompt: sin tools, sin tool_search y sin codemode la sección dice que no se alcanzan", () => {
  const section = memoryPromptSectionFor(input({ selectedTools: ["read", "bash"] }));

  assert.deepEqual(section, {
    kind: "unreachable",
    text: 'Memory tools are installed but unreachable in this session: they are not declared, and neither tool_search nor codemode can call them. Enable tool_search, enable codemode, set exposure "direct", or check the tools allowlist of the session; otherwise the memory is never read or written.',
  });
});

// The order of the two mechanisms is the contract: a match in `tool_search` stays declared for the rest of the session,
// while a codemode script has to be written again on every turn, so a session that has both is told about the search.
test("prompt: tool_search gana sobre codemode cuando los dos están declarados", () => {
  const both = memoryPromptSectionFor(input({ selectedTools: ["read", TOOL_SEARCH, CODEMODE], exposure: "deferred" }));

  assert.equal(both?.kind, "tool_search");
  assert.equal(both?.text.includes("tool_search; a match stays declared"), true);
  assert.equal(both?.text.includes("searchTools"), false);
});

// La exposición `direct` no es la que sacó las declaraciones, y `tool_search` solo indexa las tools cuya exposición es
// `codemode` o `deferred`: con `direct` una búsqueda nunca las devolvería, así que la sección no puede prometerla aunque
// `tool_search` esté declarada. El remedio que sí alcanza lo que este estado dejó roto es el script.
test("prompt: con exposure direct el aviso no promete tool_search", () => {
  const section = memoryPromptSectionFor(input({ selectedTools: ["read", TOOL_SEARCH, CODEMODE], exposure: "direct" }));

  assert.equal(section?.kind, "codemode", `con exposure direct la sección no puede nombrar tool_search; llegó: ${section?.text}`);
  assert.equal(section?.text.includes("tool_search"), false, "la sección no puede prometer una búsqueda que no indexa estas tools");
  assert.equal(section?.text.includes("searchTools"), true, "la sección nombra el script, que sí las alcanza");
});

// The defect this branch exists for: a `-t` allowlist that does not name the four filters them out of the session
// registry, so they are not merely undeclared — they are not there for `tool_search` to find and not there for a script to
// call. The section has to say they are unreachable even though `tool_search` is declared.
test("prompt: una tool ausente del registro de la sesión lleva al caso inalcanzable", () => {
  const section = memoryPromptSectionFor(
    input({
      selectedTools: ["read", "bash", TOOL_SEARCH],
      exposure: "deferred",
      registeredTools: ALL.filter((name) => name !== "memory_write"),
    }),
  );

  assert.equal(section?.kind, "unreachable", `sin la tool en el registro la sección no puede prometer un mecanismo; llegó: ${section?.text}`);
  assert.equal(section?.text.includes("unreachable"), true, "la sección tiene que decir que no se alcanzan");
  assert.equal(section?.text.includes("tool_search; a match"), false, "la búsqueda no puede devolver una tool que no está");
});

// El registro con las cuatro no cambia nada: la comprobación nueva no puede tragarse el camino normal, y la exposición
// sigue decidiendo cuál de los dos mecanismos nombra la sección.
test("prompt: el registro con las cuatro deja decidir a la exposición", () => {
  const section = memoryPromptSectionFor(
    input({ selectedTools: ["read", "bash", TOOL_SEARCH], exposure: "deferred", registeredTools: [...ALL] }),
  );

  assert.equal(section?.kind, "tool_search", `con las cuatro en el registro la exposición decide; llegó: ${section?.text}`);
});

// The list is a sentence and not a dump: one name alone, two joined by "and", and the rest by commas with the last one
// after "and". The order is `MEMORY_TOOL_NAMES` order, not the order the caller listed the declared ones in.
test("prompt: la lista de nombres perdidos se une con comas y una conjunción", () => {
  const cases: ReadonlyArray<{ readonly declared: readonly string[]; readonly list: string }> = [
    { declared: ["memory_search", "memory_read", "memory_delete"], list: "memory_write" },
    { declared: ["memory_read", "memory_delete"], list: "memory_write and memory_search" },
    { declared: ["memory_delete"], list: "memory_write, memory_search and memory_read" },
    { declared: [], list: "memory_write, memory_search, memory_read and memory_delete" },
  ];

  for (const { declared, list } of cases) {
    const section = memoryPromptSectionFor(input({ selectedTools: [TOOL_SEARCH, ...declared], exposure: "deferred" }));

    assert.ok(section !== undefined, `con ${declared.length} declaradas tiene que haber sección`);
    assert.ok(
      section.text.includes(`not declared in this prompt: ${list}.`),
      `con ${declared.length} declaradas se esperaba "${list}"; llegó: ${section.text}`,
    );
  }

  // Una lista de declaradas al revés produce la misma oración: el orden sale de la tabla de nombres.
  const backwards = memoryPromptSectionFor(
    input({ selectedTools: [TOOL_SEARCH, "memory_delete", "memory_read"], exposure: "deferred" }),
  );

  assert.ok(
    backwards?.text.includes("not declared in this prompt: memory_write and memory_search."),
    `el orden tiene que ser el de MEMORY_TOOL_NAMES; llegó: ${backwards?.text}`,
  );
});

// El techo que hace de la sección un costo menor: 360 caracteres y un solo párrafo, con los cuatro nombres perdidos, que
// es el caso más largo. El host la envuelve en su tag (+29 caracteres) y salta un cuerpo vacío.
test("prompt: cada texto cabe en 300 caracteres y no lleva saltos de línea", () => {
  const worst = [
    input({ selectedTools: [TOOL_SEARCH], exposure: "deferred" }),
    input({ selectedTools: [CODEMODE] }),
    input({ selectedTools: ["read", "bash"] }),
  ];

  for (const each of worst) {
    const section = memoryPromptSectionFor(each);

    assert.ok(section !== undefined, "con los cuatro nombres perdidos siempre hay sección");
    assert.ok(section.text.length <= 360, `${section.kind} mide ${section.text.length} caracteres, sobre 360`);
    assert.equal(section.text.includes("\n"), false, `${section.kind} lleva un salto de línea`);
  }
});

// Una sola tool perdida sigue siendo una oración: el texto nombra la lista y no la cuenta, así que el verbo no concuerda
// con el número de nombres. Con la redacción anterior la frase decía "The memory tools memory_write are".
test("prompt: con una sola tool perdida la frase sigue siendo gramatical", () => {
  const section = memoryPromptSectionFor(
    input({ selectedTools: ["read", "bash", TOOL_SEARCH, ...ALL.slice(1)], exposure: "deferred" }),
  );

  assert.ok(section !== undefined, "con una perdida tiene que haber sección");
  assert.equal(section.text.includes("tools memory_write are"), false, `la frase no concuerda; llegó: ${section.text}`);
  assert.equal(section.text.includes("memory_write is"), false, `la frase no concuerda; llegó: ${section.text}`);
  assert.ok(
    section.text.startsWith("Memory tools are installed but not declared in this prompt: memory_write."),
    `con una sola perdida la frase tiene que leerse entera; llegó: ${section.text}`,
  );
});

// El tag lo valida el host con una expresión y rechaza `preamble`, que es el texto sin tag; y va con espacio de nombres
// para que el borrado del entrypoint no pueda llevarse una sección de otra extensión.
test("prompt: el tag de la sección es un nombre válido del host", () => {
  assert.match(MEMORY_PROMPT_SECTION, /^[a-z][a-z0-9_-]*$/);
  assert.notEqual(MEMORY_PROMPT_SECTION, "preamble");
  assert.match(MEMORY_PROMPT_SECTION, /^memory/);
});
