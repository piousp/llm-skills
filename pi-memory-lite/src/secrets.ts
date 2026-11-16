const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["GitHub token", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["password", /\b(?:password|passwd)\s*[:=]\s*['"]?(?=[^\s'"<>{}$]{6,})[^\s'"<>{}$]*[^\s'"<>{}$\p{L}][^\s'"<>{}$]*/iu],
];

export function secretKindOf(text: string): string | null {
  for (const [kind, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}
