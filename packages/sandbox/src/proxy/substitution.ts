import type {
  MatcherEntry,
  Mutation,
  ProxyPolicy,
  ProxyPolicyTransform,
} from '#src/config/index.js';

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

/** Resolves credential-source strings (`env:VAR`) to concrete values. */
export interface SubstitutionResolver {
  resolve: (rawSource: string) => Promise<string>;
}

function applyTransform(
  value: string,
  transform: ProxyPolicyTransform | undefined,
): string {
  if (!transform) return value;
  // Only `base64` is defined today; the discriminator is exhaustive on the
  // schema side, so adding a new variant will surface here as a type error.
  return Buffer.from(transform.prefix + value).toString('base64');
}

/**
 * Outcome of evaluating policies against a request.
 *
 * - `pass` — request continues to its original destination with `headers`
 *   already mutated in place.
 * - `block` — short-circuit with a 403, carrying `blockedBy` (the policy
 *   id) for audit.
 * - `rewrite` — request continues but to `url` instead of its original
 *   destination. Mutations have already been applied to `headers`.
 */
export type EvaluationOutcome =
  | { outcome: 'pass'; headers: Record<string, string | string[] | undefined> }
  | {
      outcome: 'block';
      headers: Record<string, string | string[] | undefined>;
      blockedBy: string;
    }
  | {
      outcome: 'rewrite';
      headers: Record<string, string | string[] | undefined>;
      url: string;
    };

/**
 * Walk policies in order, return the outcome of the first match. If no
 * policy matches, the request passes through unmodified — the host
 * allowlist is the outer block; policies are scoped enforcement on top of
 * an already-allowlisted host.
 *
 * Within a matching `allow` policy, mutations run in array order against
 * the same headers map.
 */
export async function applyPolicies(
  policies: readonly ProxyPolicy[],
  host: string,
  path: string,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  resolver: SubstitutionResolver,
  pathWithQuery: string = path,
): Promise<EvaluationOutcome> {
  for (const policy of policies) {
    if (!matchDomain(policy.domain, host)) continue;
    if (policy.matchers && !matchesAny(policy.matchers, path, method)) continue;

    if (policy.action.type === 'block') {
      return { outcome: 'block', headers, blockedBy: policy.id };
    }
    if (policy.action.type === 'rewrite-url') {
      if (policy.action.mutations) {
        for (const mutation of policy.action.mutations) {
          await applyMutation(mutation, headers, resolver);
        }
      }
      const url = policy.action.target.split('{path}').join(pathWithQuery);
      return { outcome: 'rewrite', headers, url };
    }
    // type === 'allow'
    if (policy.action.mutations) {
      for (const mutation of policy.action.mutations) {
        await applyMutation(mutation, headers, resolver);
      }
    }
    return { outcome: 'pass', headers };
  }
  return { outcome: 'pass', headers };
}

function matchesAny(
  entries: readonly MatcherEntry[],
  path: string,
  method: string,
): boolean {
  return entries.some((entry) => matchesEntry(entry, path, method));
}

function matchesEntry(
  entry: MatcherEntry,
  path: string,
  method: string,
): boolean {
  if (entry.methods && !methodMatches(entry.methods, method)) return false;
  if ('exact' in entry) return path === entry.exact;
  if ('prefix' in entry) return prefixMatches(path, entry.prefix);
  // regex
  return new RegExp(entry.regex).test(path);
}

function methodMatches(methods: readonly string[], method: string): boolean {
  const upper = method.toUpperCase();
  return methods.some((m) => m.toUpperCase() === upper);
}

/**
 * Segment-boundary prefix match: `path` equals `prefix`, or continues with
 * `/`, or continues with `?` (query-string). Avoids the plain `startsWith`
 * footgun where `/repos/foo/bar` matches `/repos/foo/bar-evil/x`.
 */
function prefixMatches(path: string, prefix: string): boolean {
  const normalized =
    prefix.endsWith('/') && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
  if (path === normalized) return true;
  if (path.startsWith(normalized + '/')) return true;
  if (path.startsWith(normalized + '?')) return true;
  return false;
}

async function applyMutation(
  mutation: Mutation,
  headers: Record<string, string | string[] | undefined>,
  resolver: SubstitutionResolver,
): Promise<void> {
  if (mutation.kind === 'set-header') {
    const value = await resolver.resolve(mutation.value);
    const existingKey = findHeaderKey(headers, mutation.header);
    headers[existingKey ?? mutation.header] = value;
    return;
  }
  if (mutation.kind === 'remove-header') {
    const existingKey = findHeaderKey(headers, mutation.header);
    if (existingKey) headers[existingKey] = undefined;
    return;
  }
  // replace-header
  const headerKey = findHeaderKey(headers, mutation.header);
  if (!headerKey) return;
  const original = headers[headerKey];
  if (original === undefined) return;
  const matchValue = applyTransform(mutation.from, mutation.transform);
  const resolved = await resolver.resolve(mutation.to);
  const replacement = applyTransform(resolved, mutation.transform);
  if (Array.isArray(original)) {
    headers[headerKey] = original.map((v) =>
      v.includes(matchValue) ? v.split(matchValue).join(replacement) : v,
    );
  } else if (original.includes(matchValue)) {
    headers[headerKey] = original.split(matchValue).join(replacement);
  }
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
