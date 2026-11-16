import { test } from "node:test";
import assert from "node:assert/strict";
import { secretKindOf } from "../../src/secrets.ts";

const positives: readonly (readonly [string, string])[] = [
  ["AWS access key", "key AKIAIOSFODNN7EXAMPLE here"],
  ["AWS access key", "ASIAIOSFODNN7EXAMPLE"],
  ["GitHub token", `ghp_${"a1B2".repeat(9)}`],
  ["GitHub token", `github_pat_${"A1_".repeat(8)}`],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----\nabc"],
  ["private key", "-----BEGIN PRIVATE KEY-----"],
  ["Slack token", "xoxb-1234567890-abcdef"],
  ["password", "password: hunter2xyz"],
  ["password", 'passwd = "s3cretvalue"'],
  ["password", "Password=Tr0ub4dor&3"],
  ["password", "password: hunter!!x"],
];

for (const [kind, text] of positives) {
  test(`secretKindOf flags ${kind}`, () => {
    assert.equal(secretKindOf(text), kind);
  });
}

for (const text of [
  "pwd = repo root",
  "password reset flow",
  "password: <in keychain>",
  "tokens start with ghp_",
  "password: ${DB_PASSWORD}",
  "AKIA is the AWS key prefix",
  "DB password: stored in Vault at secret/db",
  "password: guardada en 1Password",
  "Password=rotated weekly",
  "password: ab1",
  // Documented tradeoff: letters-only values are indistinguishable from prose.
  "password: correcthorsebattery",
]) {
  test(`secretKindOf ignores "${text}"`, () => {
    assert.equal(secretKindOf(text), null);
  });
}
