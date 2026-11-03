import { createHash } from "node:crypto";

// Every hash this package produces comes from here (I15). The "sha256:" prefix is part of the
// decision schema and of the evidence ids, so hex and digest are two named forms of the same
// computation instead of five places that spell the prefix out.

const SHA256_PREFIX = "sha256:";

// Lowercase hex, no prefix. A string is hashed as UTF-8, which is how node hashes strings by
// default; a Buffer is hashed byte for byte.
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// "sha256:" + 64 hex.
export function sha256Digest(data: string | Buffer): string {
  return `${SHA256_PREFIX}${sha256Hex(data)}`;
}
