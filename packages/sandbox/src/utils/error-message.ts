/**
 * Extract a human-readable message from an unknown thrown value.
 * Returns `err.message` for real `Error` instances and `String(err)`
 * for anything else.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
