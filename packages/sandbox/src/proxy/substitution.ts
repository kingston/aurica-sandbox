import type { ProxyAction, ProxyActionTransform } from '#src/config/index.js';

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

function applyTransform(
  value: string,
  transform: ProxyActionTransform | undefined,
): string {
  if (!transform) return value;
  // Only `base64` is defined today; the discriminator is exhaustive on the
  // schema side, so adding a new variant will surface here as a type error.
  return Buffer.from(transform.prefix + value).toString('base64');
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
 * If the action has a `transform`, the placeholder and resolved replacement
 * are both passed through it before substring matching/replacing — this lets
 * us swap credentials inside encoded headers like `Authorization: Basic
 * <base64(user:token)>`.
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
    const matchValue = applyTransform(
      action.placeholderValue,
      action.transform,
    );
    const resolved = await resolver.resolve(action.replacementValue);
    const replacement = applyTransform(resolved, action.transform);
    if (Array.isArray(original)) {
      headers[headerKey] = original.map((v) =>
        v.includes(matchValue) ? v.split(matchValue).join(replacement) : v,
      );
    } else if (original.includes(matchValue)) {
      headers[headerKey] = original.split(matchValue).join(replacement);
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
