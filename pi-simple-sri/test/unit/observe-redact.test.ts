import { test } from "node:test";
import assert from "node:assert/strict";
import { containsSecret, redactSecrets } from "../../src/observe/redact.ts";
import { FAKE_SECRETS } from "./observe-fixtures.ts";

// Built of pieces so that no secret scanner flags this file; each value has the shape of a credential and none is one.
const SHAPES: [string, string][] = [
  ["aws access key", FAKE_SECRETS.awsKey],
  ["github token", FAKE_SECRETS.githubToken],
  ["github fine-grained token", `github_pat_${"11ABCDEFG0abcdefghij_0123456789"}`],
  ["slack token", `xox${"b"}-${"1234567890-abcdefghij"}`],
  ["provider key", `sk-${"ant-api03-"}${"abcdefghijklmnopqrstuv"}`],
  ["google key", `AIza${"SyA1234567890abcdefghijklmnopqrstuv"}`],
  ["npm token", `npm_${"abcdefghijklmnopqrstuvwxyz0123456789"}`],
  ["jwt", `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiIxMjM0NTY3ODkwIn0"}.${"abcdefghijklmnop"}`],
];

for (const [name, secret] of SHAPES) {
  test(`redactSecrets removes a ${name} and counts it once`, () => {
    const result = redactSecrets(`before ${secret} after`);
    assert.equal(result.text, "before [REDACTED] after");
    assert.equal(result.count, 1);
    assert.equal(containsSecret(`before ${secret} after`), true);
  });
}

test("redactSecrets keeps the scheme of a bearer header and removes the token", () => {
  const result = redactSecrets(`Authorization: ${FAKE_SECRETS.bearer}`);
  assert.equal(result.text, "Authorization: Bearer [REDACTED]");
  assert.equal(result.count, 1);
});

test("redactSecrets keeps the key of an assignment and removes its value", () => {
  assert.deepEqual(redactSecrets("DB_PASSWORD=hunter2hunter2"), { text: "DB_PASSWORD=[REDACTED]", count: 1 });
  assert.deepEqual(redactSecrets('{"api_key": "abcdef123456"}'), { text: '{"api_key": "[REDACTED]"}', count: 1 });
  assert.deepEqual(redactSecrets("secret: correct-horse"), { text: "secret: [REDACTED]", count: 1 });
});

test("redactSecrets counts a token behind a variable name once, not twice", () => {
  const result = redactSecrets(`GITHUB_TOKEN=${FAKE_SECRETS.githubToken}`);
  assert.equal(result.text, "GITHUB_TOKEN=[REDACTED]");
  assert.equal(result.count, 1);
});

test("redactSecrets removes the credentials of a URL and keeps the host", () => {
  const result = redactSecrets("clone https://deploy:s3cr3tpass@git.example.com/repo.git now");
  assert.equal(result.text, "clone https://[REDACTED]@git.example.com/repo.git now");
  assert.equal(result.count, 1);
});

test("redactSecrets removes a whole private key block, and an unterminated one up to the end", () => {
  const header = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;
  const footer = `-----END ${"RSA PRIVATE KEY"}-----`;
  assert.deepEqual(redactSecrets(`a\n${header}\nMIIabc\ndef\n${footer}\nb`), { text: "a\n[REDACTED]\nb", count: 1 });
  assert.deepEqual(redactSecrets(`a\n${header}\nMIIabc`), { text: "a\n[REDACTED]", count: 1 });
});

test("redactSecrets counts every occurrence", () => {
  const result = redactSecrets(`${FAKE_SECRETS.awsKey} and ${FAKE_SECRETS.githubToken} and ${FAKE_SECRETS.awsKey}`);
  assert.equal(result.text, "[REDACTED] and [REDACTED] and [REDACTED]");
  assert.equal(result.count, 3);
});

test("redactSecrets leaves ordinary text alone", () => {
  const text = "No, that is wrong: the token count is low and the password policy is in docs/security.md";
  assert.deepEqual(redactSecrets(text), { text, count: 0 });
  assert.equal(containsSecret(text), false);
  assert.equal(containsSecret(""), false);
});

test("redactSecrets is idempotent: a redacted text holds no secret", () => {
  const once = redactSecrets(
    `${FAKE_SECRETS.awsKey} TOKEN=abcdef123456 Authorization: ${FAKE_SECRETS.bearer} https://u:pw1234@h.example.com`,
  );
  assert.equal(once.count, 4);
  assert.deepEqual(redactSecrets(once.text), { text: once.text, count: 0 });
  assert.equal(containsSecret(once.text), false);
});
