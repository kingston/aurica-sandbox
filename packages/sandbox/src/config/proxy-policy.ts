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
 * ordered array; multiple mutations on the same header run in order.
 *
 * - `set-header`     overwrites the header with `value` (creates if missing).
 *                    `value` may be a credential source (e.g. `env:GH_TOKEN`)
 *                    which the resolver expands at request time.
 * - `remove-header`  drops the header entirely.
 * - `replace-header` substring substitution inside the existing header
 *                    value: `from` is matched literally; `to` may be a
 *                    credential source. Optional symmetric `transform` is
 *                    applied to both `from` and `to` before
 *                    matching/substituting (preserves the existing
 *                    `Authorization: Basic <base64(user:tok)>` flow).
 *                    No-op if `from` is not present in the header value.
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
 * Discriminated union over the actions a policy can take when it matches.
 *
 * - `allow` (default-shaped) lets the request through, optionally applying
 *   an ordered list of header mutations. Credential injection is just an
 *   `allow` policy with a single `replace-header` mutation.
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
