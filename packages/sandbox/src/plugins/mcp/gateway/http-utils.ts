/**
 * Pick a single header value from Node's `IncomingHttpHeaders` shape.
 * A repeated header surfaces as `string[]`; we take the first entry.
 */
export function pickHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
