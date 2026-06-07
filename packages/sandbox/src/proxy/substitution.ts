import type {
  MatcherEntry,
  Mutation,
  ProxyPolicy,
  ProxyPolicyTransform,
  ResponseCache,
  ResponseInterceptor,
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
 * A single mutation evaluated against a request, summarised for verbose
 * logging. `status: 'applied'` means the request was actually changed;
 * `status: 'skipped'` means the mutation matched its policy but was a
 * no-op (typically a `replace-header` whose `from` substring wasn't
 * present in the header value, or a `remove-header` for a missing
 * header). Surfacing skips is load-bearing for debugging: a silent skip
 * on a credential-substituting `replace-header` is what makes the
 * placeholder reach the upstream as-is and 401 the request.
 *
 * `target` distinguishes per-kind context the log surfaces: for header
 * mutations it's the header name.
 */
export interface AppliedMutation {
  kind:
    | 'set-header'
    | 'remove-header'
    | 'replace-header'
    /**
     * OAuth response-interceptor outcomes — emitted by the OAuth modules
     * (`oauth/intercept.ts` / `oauth/refresh.ts`) and appended to the
     * normal request's `appliedMutations` array so the verbose-mode
     * per-request block shows what happened. `target` is the recordKey;
     * `status` + `reason` distinguish the variants:
     *
     *   - `oauth-token-captured`         — applied; authorization_code response
     *                                       was captured into the slot.
     *   - `oauth-refresh-leader`         — applied; we minted a new placeholder
     *                                       counter, POSTed upstream, persisted.
     *                                       `reason` carries the new counter.
     *   - `oauth-refresh-replay`         — applied; replayed cached body.
     *                                       `reason` carries the inbound counter.
     *   - `oauth-refresh-skipped`        — skipped; future-counter / slot-empty /
     *                                       upstream-failure. `reason` explains.
     */
    | 'oauth-token-captured'
    | 'oauth-refresh-leader'
    | 'oauth-refresh-replay'
    | 'oauth-refresh-skipped'
    /**
     * Response-cache outcomes — emitted by the host proxy when an `allow`
     * policy carries a `cacheResponse`. `target` is the request URL.
     *
     *   - `cache-hit`   — applied; the body was served from the disk cache
     *                      instead of going upstream.
     *   - `cache-store` — applied; the upstream 200 body was written to the
     *                      cache for the next sandbox to reuse.
     */
    | 'cache-hit'
    | 'cache-store';
  /** Header name for `*-header` kinds, slot key for OAuth kinds, URL for
   * cache kinds. */
  target: string;
  status: 'applied' | 'skipped';
  /**
   * Free-form reason for a `skipped` status, intended for verbose logs.
   * Examples: `"header not present"`, `"from substring not found"`,
   * `"body is not JSON"`. Omitted for `applied`.
   */
  reason?: string;
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
 * `matchedPolicyId` identifies the policy whose match drove a `pass` or
 * `rewrite` outcome (undefined for `pass` when no policy matched and the
 * request fell through untouched). For `block`, read `blockedBy` instead —
 * it serves the same role and is the field embedded in the 403 body.
 * `appliedMutations` enumerates the mutations that actually ran, in order —
 * empty when none ran or when the outcome short-circuited (`block`).
 */
export type EvaluationOutcome = (
  | {
      outcome: 'pass';
      headers: Record<string, string | string[] | undefined>;
      matchedPolicyId?: string;
      /**
       * Response-side interceptor declared on the matched `allow` action,
       * if any. The host proxy hooks this into mockttp's `beforeResponse`
       * to rewrite the upstream JSON body before forwarding to the guest.
       */
      interceptResponse?: ResponseInterceptor | undefined;
      /**
       * Response cache directive declared on the matched `allow` action, if
       * any. The host proxy serves a cached body on a GET hit, or stores the
       * upstream 200 response for reuse on a miss.
       */
      cacheResponse?: ResponseCache | undefined;
    }
  | {
      outcome: 'block';
      headers: Record<string, string | string[] | undefined>;
      blockedBy: string;
    }
  | {
      outcome: 'rewrite';
      headers: Record<string, string | string[] | undefined>;
      url: string;
      matchedPolicyId: string;
    }
) & {
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
/**
 * Optional inputs to `applyPolicies` beyond the request line. Plain
 * object (rather than positional args) so future additions don't churn
 * the signature.
 */
export interface ApplyPoliciesOptions {
  /** Path including query string, for `rewrite-url` target interpolation. */
  pathWithQuery?: string;
}

export async function applyPolicies(
  policies: readonly ProxyPolicy[],
  host: string,
  path: string,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  resolver: SubstitutionResolver,
  options: ApplyPoliciesOptions = {},
): Promise<EvaluationOutcome> {
  const pathWithQuery = options.pathWithQuery ?? path;
  for (const policy of policies) {
    if (!matchDomain(policy.domain, host)) continue;
    if (policy.matchers && !matchesAny(policy.matchers, path, method)) continue;

    if (policy.action.type === 'block') {
      return {
        outcome: 'block',
        headers,
        blockedBy: policy.id,
        appliedMutations: [],
      };
    }
    const appliedMutations: AppliedMutation[] = [];
    if (policy.action.type === 'rewrite-url') {
      if (policy.action.mutations) {
        for (const mutation of policy.action.mutations) {
          appliedMutations.push(
            await applyMutation(mutation, headers, resolver),
          );
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
        appliedMutations.push(await applyMutation(mutation, headers, resolver));
      }
    }
    return {
      outcome: 'pass',
      headers,
      matchedPolicyId: policy.id,
      appliedMutations,
      interceptResponse: policy.action.interceptResponse,
      cacheResponse: policy.action.cacheResponse,
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
 * Apply a mutation in place. Always returns an {@link AppliedMutation}
 * — `status: 'applied'` when the request was changed, `status: 'skipped'`
 * with a `reason` when the mutation was a no-op (e.g. `remove-header`
 * for a header that isn't present, or `replace-header` whose `from`
 * substring wasn't found). Skips surface in the verbose log so silent
 * substitution failures — the kind that send placeholder bearers
 * straight to an upstream and 401 — are visible without a tcpdump.
 *
 * Mutations within a single policy must be applied sequentially: they share
 * the `headers` map by reference, so parallelising would race on writes
 * (e.g. a later `replace-header` reading the value an earlier `set-header`
 * just installed).
 */
async function applyMutation(
  mutation: Mutation,
  headers: Record<string, string | string[] | undefined>,
  resolver: SubstitutionResolver,
): Promise<AppliedMutation> {
  if (mutation.kind === 'set-header') {
    const value = await resolver.resolve(mutation.value);
    const existingKey = findHeaderKey(headers, mutation.header);
    headers[existingKey ?? mutation.header] = value;
    return { kind: 'set-header', target: mutation.header, status: 'applied' };
  }
  if (mutation.kind === 'remove-header') {
    const existingKey = findHeaderKey(headers, mutation.header);
    if (!existingKey) {
      return {
        kind: 'remove-header',
        target: mutation.header,
        status: 'skipped',
        reason: 'header not present',
      };
    }
    headers[existingKey] = undefined;
    return {
      kind: 'remove-header',
      target: mutation.header,
      status: 'applied',
    };
  }
  // replace-header
  const headerKey = findHeaderKey(headers, mutation.header);
  if (!headerKey) {
    return {
      kind: 'replace-header',
      target: mutation.header,
      status: 'skipped',
      reason: 'header not present',
    };
  }
  const original = headers[headerKey];
  if (original === undefined) {
    return {
      kind: 'replace-header',
      target: mutation.header,
      status: 'skipped',
      reason: 'header not present',
    };
  }
  const matchValue = applyTransform(mutation.from, mutation.transform);
  const resolved = await resolver.resolve(mutation.to);
  const replacement = applyTransform(resolved, mutation.transform);
  const didReplace = Array.isArray(original)
    ? original.some((v) => v.includes(matchValue))
    : original.includes(matchValue);
  if (!didReplace) {
    return {
      kind: 'replace-header',
      target: mutation.header,
      status: 'skipped',
      reason: 'from substring not found in header value',
    };
  }
  headers[headerKey] = Array.isArray(original)
    ? original.map((v) =>
        v.includes(matchValue) ? v.split(matchValue).join(replacement) : v,
      )
    : original.split(matchValue).join(replacement);
  return { kind: 'replace-header', target: mutation.header, status: 'applied' };
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
