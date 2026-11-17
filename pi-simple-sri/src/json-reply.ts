// The reading of a model reply that has to hold one JSON object. A model that adds a sentence, a code fence or a preamble
// still answered the question, and a "}" in the prose after the object does not make the object invalid: every "{" is a
// candidate start, each candidate is the balanced object that opens there (braces inside strings do not count), and the
// answer is the first candidate that parses and that the caller accepts.

export interface ObjectScan {
  // The balanced candidates in order of their opening brace, as text.
  objects: string[];
  // How many "{" the text holds, balanced or not: zero means no object at all, more than `objects.length` means some
  // object never closes.
  starts: number;
}

export function scanObjects(text: string): ObjectScan {
  const objects: string[] = [];
  let starts = 0;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    starts += 1;
    const object = balancedObjectAt(text, start);
    if (object !== undefined) objects.push(object);
  }
  return { objects, starts };
}

// The first balanced object that parses as JSON and that `accept` takes, or null. An object that opens and never closes
// is skipped: a later one may still be the answer.
export function firstObjectWhere<T>(text: string, accept: (value: unknown) => value is T): T | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const object = balancedObjectAt(text, start);
    if (object === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(object);
    } catch {
      continue;
    }
    if (accept(parsed)) return parsed;
  }
  return null;
}

function balancedObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return undefined;
}
