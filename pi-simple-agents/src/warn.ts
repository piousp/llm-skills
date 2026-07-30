export const WARN_PREFIX = "pi-simple-agents: ";

export function emitWarnings(warnings: string[]): void {
  warnings.forEach((w) => console.warn(WARN_PREFIX + w));
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
