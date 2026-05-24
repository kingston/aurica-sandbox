import { z } from 'zod';

/**
 * Parse a JSON config file's contents against a Zod schema, wrapping both
 * `JSON.parse` failures and Zod validation failures with the file's path so
 * users see which file is at fault and (for schema errors) a human-readable
 * issue list rather than a raw `ZodError` JSON dump.
 */
export function parseConfigFile<T extends z.ZodType>(
  configPath: string,
  raw: string,
  schema: T,
): z.infer<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Error parsing ${configPath}: invalid JSON — ${detail}`, {
      cause: err,
    });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Error parsing ${configPath}:\n${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }
  return result.data as z.infer<T>;
}
