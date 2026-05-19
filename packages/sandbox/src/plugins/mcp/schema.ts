import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

/**
 * Authentication strategy for an upstream MCP server.
 *
 * - `oauth` (default when omitted): the gateway runs Dynamic Client
 *   Registration + Authorization Code flow on the host via
 *   `aurica-sandbox mcp login`, caches tokens under
 *   `~/.aurica/sandbox/credentials.json`, and the SDK transparently
 *   refreshes them. `clientName` overrides the `client_name` advertised
 *   during DCR; some upstreams render it on the consent screen.
 * - `bearer`: no OAuth. The gateway resolves `tokenSource` (a
 *   credential-source string like `env:GH_PAT` or `gh-token`) at
 *   request time via the existing credential cache and sends
 *   `Authorization: Bearer <resolved>` on every outbound MCP call.
 *   Right for GitHub PATs and similar static-credential setups.
 */
const mcpUpstreamAuthSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('oauth'),
    clientName: z.string().optional(),
  }),
  z.object({
    type: z.literal('bearer'),
    /**
     * Credential-source reference resolved by the existing
     * {@link CredentialCache}. Plain literals are intentionally NOT
     * accepted — putting a PAT into project JSON (which is usually
     * committed) is a foot-gun we'd rather close off entirely. Use
     * `env:VAR`, `gh-token`, or a future provider.
     */
    tokenSource: z.string().min(1),
  }),
]);

/** See {@link mcpUpstreamSchema}. */
export type McpUpstreamAuth = z.infer<typeof mcpUpstreamAuthSchema>;

/**
 * Per-upstream definition. May appear under either:
 *
 * - user-level `plugins.mcp.upstreams` — the default place; OAuth
 *   tokens are host-owned and shared across every sandbox that opts
 *   in, so user-level is where most upstreams live.
 * - project-level `plugins.mcp.upstreams` — for upstreams that are
 *   project-scoped (an internal GHE host, a bearer-auth PAT used only
 *   by one project, …). Project entries are merged into the user
 *   catalog by name: where both declare the same name, the project's
 *   `url` / `auth` / `clientName` win field-by-field.
 *
 * `auth` defaults to `{ type: 'oauth' }` when omitted.
 */
const mcpUpstreamSchema = z.object({
  url: z.url(),
  auth: mcpUpstreamAuthSchema.optional(),
});

/** See {@link mcpUserConfigSchema}. */
export type McpUpstreamConfig = z.infer<typeof mcpUpstreamSchema>;

/**
 * User-level config for the `mcp` plugin. Holds the default upstream
 * catalog; project configs may add to or override entries (see
 * {@link mcpUpstreamSchema}).
 */
export const mcpUserConfigSchema = z.object({
  upstreams: z.record(z.string().min(1), mcpUpstreamSchema).default({}),
});

/** See {@link mcpUserConfigSchema}. */
export type McpUserConfig = z.infer<typeof mcpUserConfigSchema>;

/**
 * Argument-value scalar accepted by a {@link mcpToolPolicySchema}
 * `arguments` map. Non-scalar values (arrays, objects) are rejected in
 * v1; a tool call whose arg is non-scalar simply won't satisfy any
 * policy that constrains that key, so it falls through to
 * `defaultAction`.
 */
const argScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * One policy rule on a server entry. A call to `tools/call` is allowed
 * iff some policy matches it — `name` is in `tools`, and (if
 * `arguments` is set) every listed key in `arguments` equals (`===`)
 * the corresponding key on the call's arguments. Extra keys on the
 * call are ignored (subset semantics). v1 limits `action` to `allow`;
 * the discriminated shape leaves room for explicit `block`.
 */
const mcpToolPolicySchema = z.object({
  tools: z.array(z.string().min(1)).nonempty(),
  arguments: z.record(z.string().min(1), argScalarSchema).optional(),
  action: z.object({ type: z.literal('allow') }),
});

/** See {@link mcpToolPolicySchema}. */
export type McpToolPolicy = z.infer<typeof mcpToolPolicySchema>;

/**
 * Action applied when no policy on a server entry matches a given
 * `tools/call`. Defaults to `block` when policies are declared but
 * `defaultAction` is omitted — see {@link normalizeServerEntries}.
 */
const mcpDefaultActionSchema = z.object({
  type: z.enum(['allow', 'block']),
});

/**
 * Per-server entry in a project's `plugins.mcp.servers` list.
 *
 * - Bare-string form (`"linear"`) advertises the server with no
 *   restrictions: every tool the upstream exposes is allowed.
 * - Object form may carry `policies` (per-tool, per-argument
 *   allowlist) and a `defaultAction` for unmatched calls. Omitting
 *   `policies` AND `defaultAction` is equivalent to the bare-string
 *   form. Setting `policies` without `defaultAction` defaults the
 *   fallback to `block`.
 */
const serverEntrySchema = z.union([
  z.string().regex(/^[a-z0-9][a-z0-9-]*$/i),
  z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i),
    policies: z.array(mcpToolPolicySchema).nonempty().optional(),
    defaultAction: mcpDefaultActionSchema.optional(),
  }),
]);

/** See {@link mcpProjectConfigSchema}. */
export type McpServerEntry = z.infer<typeof serverEntrySchema>;

/**
 * Canonical form of a {@link McpToolPolicy} after normalization.
 * `action` is omitted from the canonical shape because v1 policies
 * are implicitly `allow`; if we add `block` later, this gains a
 * discriminator field without changing call sites of the matcher.
 */
export interface CanonicalToolPolicy {
  tools: readonly string[];
  arguments: Readonly<Record<string, string | number | boolean>> | undefined;
}

/**
 * Canonical form of a project-declared server entry. The schema accepts
 * a bare-string shorthand for "no restrictions";
 * {@link normalizeServerEntries} folds both forms into this
 * representation so downstream code only ever sees one shape.
 */
export interface CanonicalServerEntry {
  name: string;
  policies: readonly CanonicalToolPolicy[];
  defaultAction: 'allow' | 'block';
}

/**
 * Project-level config for the `mcp` plugin.
 *
 * `servers` lists the upstream MCP servers (defined under the user-level
 * `plugins.mcp.upstreams` block) this sandbox is allowed to reach.
 * Cross-validation against the user-level catalog happens at sandbox
 * create / proxy reload time — an unknown name fails fast with a clear
 * error rather than being silently dropped.
 *
 * Each name must be a valid path segment (kebab-case, no slashes) so it
 * can be used verbatim in the gateway's path-based routing:
 * `https://aurica.mcp.internal/<server>/mcp` maps one-to-one to a name
 * in this list.
 */
export const mcpProjectConfigSchema = z.object({
  servers: z
    .array(serverEntrySchema)
    .default([])
    .describe(
      'Upstream MCP servers (declared in user config) this sandbox may reach.',
    ),
  /**
   * Project-scoped upstream catalog. Merged into the user-level
   * `plugins.mcp.upstreams` by name at sandbox-create + proxy-reload
   * time. Where both declare the same name, the project entry wins
   * field-by-field (`url`, `auth`, `clientName`).
   *
   * Useful for upstreams that aren't a user-wide default — an internal
   * GHE host, a bearer-auth PAT scoped to one repo, …
   */
  upstreams: z
    .record(z.string().min(1), mcpUpstreamSchema)
    .default({})
    .describe(
      'Project-scoped MCP upstreams, merged over `plugins.mcp.upstreams` in user config.',
    ),
});

/** See {@link mcpProjectConfigSchema}. */
export type McpProjectConfig = z.infer<typeof mcpProjectConfigSchema>;

/**
 * Normalize the heterogeneous `servers` list into uniform
 * {@link CanonicalServerEntry} records. Call once at the boundary
 * (plugin `initialize`, gateway tenant rebuild) so downstream code
 * never branches on the union shape.
 *
 * `defaultAction` folds out:
 * - bare-string entry → `'allow'`
 * - object entry, no `policies`, no `defaultAction` → `'allow'`
 * - object entry, `policies` set, no `defaultAction` → `'block'`
 * - object entry, `defaultAction` set → `defaultAction.type`
 */
export function normalizeServerEntries(
  entries: readonly McpServerEntry[],
): CanonicalServerEntry[] {
  return entries.map((entry) => {
    if (typeof entry === 'string') {
      return { name: entry, policies: [], defaultAction: 'allow' };
    }
    const policies: CanonicalToolPolicy[] = (entry.policies ?? []).map((p) => ({
      tools: p.tools,
      arguments: p.arguments,
    }));
    const defaultAction: 'allow' | 'block' = entry.defaultAction
      ? entry.defaultAction.type
      : policies.length > 0
        ? 'block'
        : 'allow';
    return { name: entry.name, policies, defaultAction };
  });
}

/**
 * Re-parse `userConfig.plugins.mcp` through this plugin's user-config
 * schema. The framework types `plugins.<name>` as a union across every
 * registered plugin's user-config shape, so a property lookup on the
 * union doesn't narrow; re-parsing recovers the precise `McpUserConfig`
 * (and applies the empty-default for absent blocks).
 */
export function readMcpUserConfig(userConfig: {
  plugins: Record<string, unknown>;
}): McpUserConfig {
  return mcpUserConfigSchema.parse(userConfig.plugins.mcp ?? {});
}

/**
 * Canonical upstream definition after merge + auth normalization. The
 * raw schema accepts a deprecated top-level `clientName` for backwards
 * compatibility; the normalizer folds it into `auth.clientName` so
 * downstream code only ever reads the discriminated union.
 */
export type CanonicalMcpUpstream =
  | { url: string; auth: { type: 'oauth'; clientName: string | undefined } }
  | { url: string; auth: { type: 'bearer'; tokenSource: string } };

/**
 * Normalize a raw {@link McpUpstreamConfig} into its canonical form.
 * Defaults `auth` to `{ type: 'oauth' }` when omitted.
 */
export function normalizeUpstream(
  raw: McpUpstreamConfig,
): CanonicalMcpUpstream {
  const auth = raw.auth ?? { type: 'oauth' };
  if (auth.type === 'bearer') {
    return {
      url: raw.url,
      auth: { type: 'bearer', tokenSource: auth.tokenSource },
    };
  }
  return {
    url: raw.url,
    auth: { type: 'oauth', clientName: auth.clientName },
  };
}

/**
 * Merge a project's `plugins.mcp.upstreams` over the user catalog. The
 * project entry replaces the user entry atomically — both fields
 * (`url`, `auth`) come from the project side, since a partial override
 * doesn't make sense once `auth` is a discriminated union. Brand-new
 * project names are added.
 */
export function mergeUpstreamCatalogs(
  user: Record<string, McpUpstreamConfig>,
  project: Record<string, McpUpstreamConfig>,
): Record<string, CanonicalMcpUpstream> {
  const merged: Record<string, McpUpstreamConfig> = { ...user, ...project };
  const out: Record<string, CanonicalMcpUpstream> = {};
  for (const [name, entry] of Object.entries(merged)) {
    out[name] = normalizeUpstream(entry);
  }
  return out;
}

/**
 * Shared OAuth client metadata defaults used both for `mcp login` (CLI)
 * and for transparent token refresh inside the gateway sidecar. The two
 * must agree on every field except `redirect_uris` — DCR keys the cached
 * client_information on the registered metadata, and a refresh that
 * presents different metadata triggers re-registration on every refresh.
 *
 * `redirect_uris` is intentionally omitted: the CLI binds an ephemeral
 * loopback port per `mcp login`, while the sidecar (which never opens a
 * browser) substitutes an unused-but-syntactically-valid placeholder.
 * Callers pick the one they need and spread it into the base.
 */
export const BASE_OAUTH_CLIENT_METADATA: Omit<
  OAuthClientMetadata,
  'redirect_uris'
> = {
  client_name: 'aurica-sandbox',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

/**
 * Redirect URI baked into the sidecar's metadata. The sidecar never
 * actually completes an interactive flow — it only refreshes — but the
 * field is required by the OAuth client-metadata schema. `127.0.0.1` is
 * unreachable from upstreams so a leaked metadata blob can't be used to
 * hijack a code, and the path is suggestive of its intent.
 */
export const SIDECAR_OAUTH_REDIRECT_URI = 'http://127.0.0.1/unused';

/**
 * Build the OAuth client metadata the sidecar advertises during refresh.
 * Applies the per-upstream `clientName` override when configured. Must
 * match what `mcp login` registered, otherwise the SDK's `auth()` helper
 * re-registers the client on every refresh.
 */
export function sidecarOAuthClientMetadata(
  clientName: string | undefined,
): OAuthClientMetadata {
  return {
    ...BASE_OAUTH_CLIENT_METADATA,
    ...(clientName ? { client_name: clientName } : {}),
    redirect_uris: [SIDECAR_OAUTH_REDIRECT_URI],
  };
}
