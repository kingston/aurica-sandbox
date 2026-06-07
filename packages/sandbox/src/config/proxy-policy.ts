import { z } from 'zod';

/**
 * Optional encoding applied symmetrically to both `from` (when matching the
 * on-the-wire header value) and the resolved `to` (before substituting it
 * in). Lets us pin a substitution rule to a header value that the client
 * encodes before it leaves the VM, e.g. HTTP Basic auth where git
 * base64-encodes `username:token` into `Authorization: Basic …`.
 *
 * `prefix` is concatenated in front of the value before encoding (e.g.
 * `"username:"` for Basic auth). Empty prefix is allowed if you only need
 * the encoding step.
 */
export const proxyPolicyTransformSchema = z.object({
  type: z.literal('base64'),
  prefix: z.string(),
});

/** Symmetric encoding applied to a `replace-header` mutation's from/to. */
export type ProxyPolicyTransform = z.infer<typeof proxyPolicyTransformSchema>;

/**
 * Canonical HTTP methods. The matcher checks `methods` case-insensitively
 * against the request method, so configs may use upper or lower case.
 */
export const httpMethodSchema = z.enum([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** HTTP method enum used in matcher entries. */
export type HttpMethod = z.infer<typeof httpMethodSchema>;

/**
 * One entry in a policy's `matchers` list. Conditions AND together within
 * an entry; entries OR together across the list (any entry matching means
 * the policy fires). Exactly one of `exact` / `prefix` / `regex` is set.
 *
 * - `exact`  — request path equals the value, case-sensitive.
 * - `prefix` — segment-boundary prefix match: path equals the value, OR
 *              continues with `/`, OR continues with `?` (query string).
 *              `/repos/foo/bar` does NOT match `/repos/foo/bar-evil/x` —
 *              this is the correctness fix vs. plain `startsWith`.
 * - `regex`  — anchored `RegExp` evaluation against the path. Compiled
 *              once at parse time. Powerful escape hatch; prefer `prefix`
 *              when it suffices.
 *
 * `methods` (optional) restricts the entry to the listed HTTP methods.
 * Omitted means "any method".
 */
export const matcherEntrySchema = z.union([
  z.object({
    exact: z.string().min(1),
    methods: z.array(httpMethodSchema).nonempty().optional(),
  }),
  z.object({
    prefix: z.string().min(1),
    methods: z.array(httpMethodSchema).nonempty().optional(),
  }),
  z.object({
    regex: z.string().min(1),
    methods: z.array(httpMethodSchema).nonempty().optional(),
  }),
]);

/** One entry in a policy's `matchers` list — see {@link matcherEntrySchema}. */
export type MatcherEntry = z.infer<typeof matcherEntrySchema>;

/**
 * One mutation applied when an `allow` policy matches. Mutations are an
 * ordered array; multiple mutations on the same header / body field run
 * in order.
 *
 * - `set-header`        overwrites the header with `value` (creates if
 *                       missing). `value` may be a credential source
 *                       (e.g. `env:GH_TOKEN`) which the resolver expands
 *                       at request time.
 * - `remove-header`     drops the header entirely.
 * - `replace-header`    substring substitution inside the existing header
 *                       value: `from` is matched literally; `to` may be a
 *                       credential source. Optional symmetric `transform`
 *                       is applied to both `from` and `to` before
 *                       matching/substituting (preserves the existing
 *                       `Authorization: Basic <base64(user:tok)>` flow).
 *                       No-op if `from` is not present in the header.
 */
export const mutationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('set-header'),
    header: z.string().min(1),
    value: z.string().min(1),
  }),
  z.object({
    kind: z.literal('remove-header'),
    header: z.string().min(1),
  }),
  z.object({
    kind: z.literal('replace-header'),
    header: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    transform: proxyPolicyTransformSchema.optional(),
  }),
]);

/** A single header mutation — see {@link mutationSchema}. */
export type Mutation = z.infer<typeof mutationSchema>;

/**
 * Response-side interceptor: capture the upstream response body of a
 * matched request and rewrite it before forwarding to the guest. The
 * proxy registers a `beforeResponse` hook on the matching rule when
 * this is present.
 *
 * Today only one variant exists: `oauth-token-response` recognises an
 * RFC 6749 token-grant JSON body, persists the real `access_token` /
 * `refresh_token` into the host credential record named by `recordKey`,
 * and rewrites the body so the guest sees `placeholders.accessToken` /
 * `placeholders.refreshToken` + a far-future `expires_in` instead. The
 * placeholders are the same per-sandbox strings the request-side
 * `replace-header` swaps back to a real token on outbound requests, so
 * the guest stays in placeholder-land permanently.
 *
 * `recordKey` is the namespaced record key used by the credentials store
 * (e.g. `claude-code:oauth`). The interceptor calls
 * `defineCredentialRecord` on that key with the same schema the
 * consuming plugin uses.
 */
export const responseInterceptorSchema = z.object({
  kind: z.literal('oauth-token-response'),
  recordKey: z.string().min(1),
  placeholders: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
  }),
});

/** A response-side interceptor — see {@link responseInterceptorSchema}. */
export type ResponseInterceptor = z.infer<typeof responseInterceptorSchema>;

/** Default cache TTL: 7 days. Content-addressed URLs never change, so a long
 * TTL is safe and maximises hits across sandbox runs. */
const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Response cache directive on an `allow` action. When present and the request
 * is a `GET`, the proxy serves a previously-cached body from the host-global
 * disk cache instead of going upstream; on a miss, it stores the upstream
 * `200` response (raw bytes + headers) for the next sandbox to reuse.
 *
 * The cache is keyed by method + full URL and is **shared across all
 * sandboxes** — VM #2 serves the bytes VM #1 downloaded. Because of that,
 * only attach this to policies whose responses are **public, unauthenticated,
 * and immutable** (ideally content-addressed, e.g. a hash in the path). A
 * response that varies by `Authorization` or per-user state would leak across
 * sandboxes. Only `GET` requests with a `200` status are ever cached.
 *
 * `ttlSeconds` bounds staleness; defaults to 7 days. There is no size cap or
 * eviction today — the cache grows unbounded under the state dir; clear it
 * manually if needed.
 */
export const responseCacheSchema = z.object({
  ttlSeconds: z.number().int().positive().default(DEFAULT_CACHE_TTL_SECONDS),
});

/** A response cache directive — see {@link responseCacheSchema}. */
export type ResponseCache = z.infer<typeof responseCacheSchema>;

/**
 * Discriminated union over the actions a policy can take when it matches.
 *
 * - `allow` (default-shaped) lets the request through, optionally applying
 *   an ordered list of header mutations. Credential injection is just an
 *   `allow` policy with a single `replace-header` mutation. An optional
 *   `interceptResponse` registers a response-side rewrite hook — used by
 *   `subscription` mode to capture Anthropic-issued OAuth tokens off the
 *   wire and persist them to the host store. An optional `cacheResponse`
 *   serves/stores the response from a host-global disk cache (GET + 200
 *   only) — see {@link responseCacheSchema}.
 * - `block` short-circuits with a 403 response. The proxy mentions the
 *   policy id in the body for audit.
 * - `rewrite-url` lets the request through but redirects it to a different
 *   destination URL. `target` is a template string in which `{path}`
 *   expands to the original request path (including query). Mutations
 *   still run against the request headers before forwarding, so the
 *   rewritten request can have its `Authorization` swapped to a
 *   gateway-specific bearer.
 */
export const policyActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('allow'),
    mutations: z.array(mutationSchema).optional(),
    interceptResponse: responseInterceptorSchema.optional(),
    cacheResponse: responseCacheSchema.optional(),
  }),
  z.object({
    type: z.literal('block'),
  }),
  z.object({
    type: z.literal('rewrite-url'),
    target: z.string().min(1),
    mutations: z.array(mutationSchema).optional(),
  }),
]);

/** A policy's action — see {@link policyActionSchema}. */
export type PolicyAction = z.infer<typeof policyActionSchema>;

/**
 * One proxy policy. Policies are evaluated **first-match-wins** over the
 * full list per request:
 *
 * 1. Skip policies whose `domain` doesn't match the request host.
 * 2. Skip policies whose `matchers` list is set and contains no entry
 *    matching `(path, method)`. If `matchers` is omitted, the policy
 *    matches any path/method on the domain.
 * 3. Apply the first matching policy's `action` and stop.
 *
 * If no policy matches an allowlisted host, the request passes through
 * unmodified. The host-allowlist sweep is the outer 403 net for hosts
 * not allowlisted at all.
 *
 * `id` is a stable identifier surfaced in audit logs and the body of any
 * 403 a `block` action emits. `description` is free-form prose.
 *
 * `domain` supports the same wildcard syntax as the host allowlist
 * (e.g. `*.foo.com`).
 */
export const proxyPolicySchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  domain: z.string().min(1),
  matchers: z.array(matcherEntrySchema).optional(),
  action: policyActionSchema,
});

/** A single proxy policy — see {@link proxyPolicySchema}. */
export type ProxyPolicy = z.infer<typeof proxyPolicySchema>;
