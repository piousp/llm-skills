// Base of every error this package raises on purpose. The package fails closed: a value it
// cannot prove safe is a refusal, never a silent fallback, so each error carries a message that
// names what was refused and the context (a settings file, a target path) it is about.
//
// Subclasses live here instead of in the module that raises them so a caller can tell the
// refusals of the whole package apart with one `instanceof SriFailClosedError`. The module that
// raises each one re-exports it, so the import path callers already use keeps working.

export class SriFailClosedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Taken from the class actually constructed, so a subclass that only declares its extra
    // field still shows its own name in a log or a stack trace.
    this.name = this.constructor.name;
  }
}

// Fail-closed: a settings shape this module cannot read is an error with the file path on it,
// never a silent fallback to "everything eligible". `settingsPath` is absent when there is no
// file to blame (parseSriConfig validates an object that came from somewhere else), which is a
// different statement from "the path is the empty string".
export class SriConfigError extends SriFailClosedError {
  readonly settingsPath?: string;

  constructor(message: string, settingsPath?: string) {
    super(message);
    this.settingsPath = settingsPath;
  }
}

// A target that cannot be proven to be inside a writable root is refused before any byte
// reaches it. `target` is the path the caller asked to write, as it was reported to them.
export class SriPerimeterError extends SriFailClosedError {
  readonly target: string;

  constructor(message: string, target: string) {
    super(message);
    this.target = target;
  }
}

// Fail-closed write error: read-back mismatch, a history snapshot that already exists, an
// unreadable skill, an unusable timestamp. Perimeter rejections use SriPerimeterError.
//
// `target` is the path the caller asked to write, as it was reported to them, and it is absent when
// the failure has no path to blame -- a date that cannot name a staging directory. It used to be
// required, so that one refusal passed "" and every reader had to know the empty string meant "no
// path": an absent field says the same thing without a value that pretends to be one.
export class SriWriterError extends SriFailClosedError {
  readonly target?: string;

  constructor(message: string, target?: string) {
    super(message);
    this.target = target;
  }
}

// Fail-closed diagnosis error: no evidence, or no failure that can be replayed as asked.
export class SriDiagnosisError extends SriFailClosedError {}

// Fail-closed generation error: no evidence to back a lesson, a reply that is not the JSON object
// the prompt asked for, a model that stopped for a reason other than "stop", or a lesson the
// frontmatter validator refuses. The proposer writes nothing, so none of these has a path to blame.
//
// Named ProposerError rather than SriProposerError because it is the contract callers switch on,
// next to the type it is returned in; it keeps the shared base class so a caller can still catch
// every refusal of the package at once.
export class ProposerError extends SriFailClosedError {}
