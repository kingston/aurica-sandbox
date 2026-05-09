import type { ProxyAction } from '#src/config/index.js';

/**
 * Match a host against a pattern. `*.example.com` matches `example.com` and
 * any subdomain (`api.example.com`, `a.b.example.com`); plain patterns must
 * match exactly. Case-insensitive.
 */
export function matchDomain(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return h === p.slice(2) || h.endsWith(suffix);
  }
  return p === h;
}

export interface SubstitutionResolver {
  resolve: (rawSource: string) => Promise<string>;
}

/**
 * Apply credential substitutions to a header map for a request to
 * `host`+`path`.
 *
 * Match is `(host, [pathPrefix,] header, placeholder)` — substitution is
 * scoped to the configured header and domain, plus optionally a path prefix
 * (case-sensitive). When `pathPrefix` is set on an action, the action only
 * fires if `path.startsWith(pathPrefix)`; otherwise it fires for any path on
 * the matching host. Collisions across domains, headers, or paths cannot
 * occur.
 *
 * Mutates `headers` in place and returns it.
 */
export async function applyActions(
  actions: readonly ProxyAction[],
  host: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  resolver: SubstitutionResolver,
): Promise<Record<string, string | string[] | undefined>> {
  for (const action of actions) {
    if (!matchDomain(action.domain, host)) continue;
    if (action.pathPrefix && !path.startsWith(action.pathPrefix)) continue;
    const headerKey = findHeaderKey(headers, action.header);
    if (!headerKey) continue;
    const original = headers[headerKey];
    if (original === undefined) continue;
    const replacement = await resolver.resolve(action.replacementValue);
    if (Array.isArray(original)) {
      headers[headerKey] = original.map((v) =>
        v.includes(action.placeholderValue)
          ? v.split(action.placeholderValue).join(replacement)
          : v,
      );
    } else if (original.includes(action.placeholderValue)) {
      headers[headerKey] = original
        .split(action.placeholderValue)
        .join(replacement);
    }
  }
  return headers;
}

function findHeaderKey(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return k;
  }
  return undefined;
}
