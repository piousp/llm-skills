export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  model?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  defaultReads?: string[];
  [key: string]: unknown;
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const LIST_FIELDS = new Set(["tools", "defaultReads"]);

function parseValue(key: string, rawValue: string): unknown {
  if (LIST_FIELDS.has(key)) {
    return rawValue
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (key === "inheritProjectContext") {
    if (rawValue === "true") return true;
    if (rawValue === "false") return false;
  }
  return rawValue;
}

export function parseFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter;
  body: string;
} {
  const match = content.match(FRONTMATTER_BLOCK);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: ParsedFrontmatter = {};
  const block = match[1];
  const body = content.slice(match[0].length);

  for (const line of block.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!key) continue;

    frontmatter[key] = parseValue(key, rawValue);
  }

  return { frontmatter, body };
}
