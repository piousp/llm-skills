import path from "node:path";
import { fileURLToPath } from "node:url";

// Locations of the package itself. The root is derived from the module URL of the caller
// instead of from a resolved lookup of package.json: pi loads the extension with jiti from
// whichever directory holds the package, so import.meta.url is the reliable anchor
// (examples/extensions/dynamic-resources/index.ts:5 does the same).
//
// These functions only compute paths. None of them creates a directory: the first writer
// that needs one creates it, so asking where things go never has a side effect, and a
// package directory that cannot be written fails at the write, not here.

// Precondition: moduleUrl is the import.meta.url of a module that sits directly in
// <package root>/extensions/ -- extensions/index.ts in practice, which is the file pi
// loads. Two levels up from there is the package root. A module nested deeper
// (extensions/gate/session.ts) or living in src/ must pass the URL of
// extensions/index.ts rather than its own, or the result is a directory inside the
// package.
export function packageRoot(moduleUrl: string): string {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}

export function stagingDir(root: string): string {
  return path.join(root, "staging");
}

export function stateDir(root: string): string {
  return path.join(root, "state");
}
