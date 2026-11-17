// Secrets are removed before anything is persisted or sent to the judge. The patterns cover the credential shapes that
// show up in transcripts (provider keys, tokens, bearer headers, key=value assignments, URL credentials, private keys).
// It errs on the side of redacting: a false positive costs a word of context, a miss costs a leaked credential.

const REDACTED = "[REDACTED]";

interface SecretPattern {
  pattern: RegExp;
  // The text that stands in for a match; receives the groups the pattern captured.
  replace: (...groups: string[]) => string;
}

const whole = (): string => REDACTED;

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: whole },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: whole },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: whole },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: whole },
  { pattern: /\bnpm_[A-Za-z0-9]{30,}/g, replace: whole },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: whole },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, replace: whole },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: whole },
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replace: (head) => `${head}${REDACTED}` },
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
    replace: (scheme) => `${scheme}${REDACTED}@`,
  },
  {
    pattern:
      /([\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;}]{6,})/gi,
    // A value an earlier pattern already replaced stays as it is, so redacting twice changes nothing.
    replace: (key, separator, value) => (value.startsWith("[REDACTED") ? `${key}${separator}${value}` : `${key}${separator}${REDACTED}`),
  },
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let redacted = text;

  for (const { pattern, replace } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match: string, ...captured: unknown[]) => {
      const groups = captured.filter((value): value is string => typeof value === "string");
      const replacement = replace(...groups);
      // The kv pattern hands back a match that is already redacted: that is not a new secret.
      if (replacement !== match) count += 1;
      return replacement;
    });
  }

  return { text: redacted, count };
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text).count > 0;
}
