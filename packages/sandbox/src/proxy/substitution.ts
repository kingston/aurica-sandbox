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
 * A single mutation that was actually performed against a request, summarised
 * for verbose logging. `value` is the post-resolution, post-transform string
 * that the upstream will see; `redacted` is true when that value originated
 * from a credential source (`env:VAR`) — callers should not echo the raw
 * value to logs in that case.
 */
export interface AppliedMutation {
  kind: 'set-header' | 'remove-header' | 'replace-header';
  header: string;
  value?: string;
  redacted?: boolean;
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
 *
 * `matchedPolicyId` identifies the policy whose match drove the outcome
 * (undefined when no policy matched and the request passes through
 * untouched). `appliedMutations` enumerates the mutations that ran, in
 * order — empty when none ran.
 */
export type EvaluationOutcome = (
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
    }
) & {
  matchedPolicyId?: string;
  appliedMutations: AppliedMutation[];
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
      return {
        outcome: 'block',
        headers,
        blockedBy: policy.id,
        matchedPolicyId: policy.id,
        appliedMutations: [],
      };
    }
    const appliedMutations: AppliedMutation[] = [];
    if (policy.action.type === 'rewrite-url') {
      if (policy.action.mutations) {
        for (const mutation of policy.action.mutations) {
          const applied = await applyMutation(mutation, headers, resolver);
          if (applied) appliedMutations.push(applied);
        }
      }
      const url = policy.action.target.split('{path}').join(pathWithQuery);
      return {
        outcome: 'rewrite',
        headers,
        url,
        matchedPolicyId: policy.id,
        appliedMutations,
      };
    }
    // type === 'allow'
    if (policy.action.mutations) {
      for (const mutation of policy.action.mutations) {
        const applied = await applyMutation(mutation, headers, resolver);
        if (applied) appliedMutations.push(applied);
      }
    }
    return {
      outcome: 'pass',
      headers,
      matchedPolicyId: policy.id,
      appliedMutations,
    };
  }
  return { outcome: 'pass', headers, appliedMutations: [] };
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

/**
 * Apply a mutation in place. Returns a summary of what happened (the header
 * name, plus a value when relevant) so callers can log it, or `null` when
 * the mutation was a no-op (e.g. `remove-header` for a header that isn't
 * present, or `replace-header` whose `from` didn't match).
 *
 * `value` is omitted for `remove-header`. `redacted` is true when the value
 * was sourced from `resolver.resolve` (i.e. credentials) — callers should
 * not echo it to logs.
 */
async function applyMutation(
  mutation: Mutation,
  headers: Record<string, string | string[] | undefined>,
  resolver: SubstitutionResolver,
): Promise<AppliedMutation | null> {
  if (mutation.kind === 'set-header') {
    const value = await resolver.resolve(mutation.value);
    const existingKey = findHeaderKey(headers, mutation.header);
    headers[existingKey ?? mutation.header] = value;
    return {
      kind: 'set-header',
      header: mutation.header,
      value,
      redacted: true,
    };
  }
  if (mutation.kind === 'remove-header') {
    const existingKey = findHeaderKey(headers, mutation.header);
    if (!existingKey) return null;
    headers[existingKey] = undefined;
    return { kind: 'remove-header', header: mutation.header };
  }
  // replace-header
  const headerKey = findHeaderKey(headers, mutation.header);
  if (!headerKey) return null;
  const original = headers[headerKey];
  if (original === undefined) return null;
  const matchValue = applyTransform(mutation.from, mutation.transform);
  const resolved = await resolver.resolve(mutation.to);
  const replacement = applyTransform(resolved, mutation.transform);
  const didReplace = Array.isArray(original)
    ? original.some((v) => v.includes(matchValue))
    : original.includes(matchValue);
  if (!didReplace) return null;
  headers[headerKey] = Array.isArray(original)
    ? original.map((v) =>
        v.includes(matchValue) ? v.split(matchValue).join(replacement) : v,
      )
    : original.split(matchValue).join(replacement);
  return {
    kind: 'replace-header',
    header: mutation.header,
    value: replacement,
    redacted: true,
  };
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
