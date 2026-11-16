// The text of a memory, turned into the four forms the index needs: the tokens of an FTS5 query, the controlled
// vocabulary slug of a category, the form duplicate detection compares and the denormalized `terms` column. No import,
// no file, no clock, no model: every function here is a function of its argument alone, and none of them throws on any
// input, because the input is the text a model wrote.

const MAX_FTS_TOKENS = 16;
const MAX_SLUG_LENGTH = 32;

/**
 * Appends `value` when the list does not hold it yet, which is what keeps the first appearance of every element. It lives
 * here, the one module with no import of its own, because the call sites that need it — a slug list, the settings
 * vocabulary, the ids of a catalog page and the names of a tool listing — share this rule instead of writing it four
 * times.
 */
export function appendUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * The canonical form both the tokens and the slug start from: NFKD, diacritics stripped, lowercased. Never throws, because
 * the input is the text a model wrote.
 */
function canonical(raw: string): string {
  return raw.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The canonical form as the degraded search applies it to stored text, so `cafe` finds `Café`. */
export const foldForSearch = canonical;

/** NFKD, diacritics stripped, lowercased, alphanumeric runs, capped at 16 tokens. Never throws. */
export function toTokens(raw: string): string[] {
  const tokens = canonical(raw).match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.slice(0, MAX_FTS_TOKENS);
}

/** Each token as a quoted FTS5 term, an embedded double quote doubled. The AND between terms is the join. */
export function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/** A token as an FTS5 term: quoted, and a prefix from three characters on, so "deploy" finds "deployments". */
export function toMatchTerm(token: string): string {
  return quoteToken(token) + (token.length >= 3 ? "*" : "");
}

/** Controlled-vocabulary slug: NFKD, diacritics stripped, lowercased, non-alphanumeric runs to a single hyphen, edges trimmed, capped at 32 characters. Empty input returns "". */
export function toSlug(term: string): string {
  // The trim before the cut is what leaves no hyphen at the front; the trim after it is what keeps the cut of the 32nd
  // character from leaving one at the back, because the byte where a slug is cut can fall inside a hyphen run.
  const collapsed = canonical(term)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed.slice(0, MAX_SLUG_LENGTH).replace(/^-+|-+$/g, "");
}

/** NFKC, trimmed, internal whitespace collapsed to one space, lowercased. Used only for duplicate detection. */
export function normalizeTextForDuplicate(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The slugs of these keys, empty ones dropped, duplicates removed preserving the first appearance. */
export function distinctSlugs(keys: readonly string[]): string[] {
  const slugs: string[] = [];
  for (const key of keys) {
    const slug = toSlug(key);
    if (slug === "") continue;
    appendUnique(slugs, slug);
  }
  return slugs;
}

/** Slugs of the keys, in the order of `distinctSlugs`, joined by a single space. */
export function toTerms(keys: readonly string[]): string {
  return distinctSlugs(keys).join(" ");
}
