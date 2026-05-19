import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

/**
 * Per-upstream definition under the user-level `plugins.mcp.upstreams`
 * block. The gateway sidecar reads this catalog at boot to know which
 * upstreams to mount; per-project opt-in (`plugins.mcp.servers: [...]`)
 * then references upstreams by name. Storing definitions here (rather
 * than in each project) means tokens are cached once on the host and
 * shared across sandboxes.
 */
const mcpUpstreamSchema = z.object({
  url: z.url(),
  /**
   * Optional `client_name` sent during Dynamic Client Registration.
   * Falls back to `aurica-sandbox` when omitted. Some upstreams display
   * this string in their authorization screen, so users may want to
   * override it.
   */
  clientName: z.string().optional(),
});

/** See {@link mcpUserConfigSchema}. */
export type McpUpstreamConfig = z.infer<typeof mcpUpstreamSchema>;

/**
 * User-level config for the `mcp` plugin. The `upstreams` catalog lives
 * here (not on the project) because OAuth tokens are host-owned and
 * shared across every sandbox that opts into a given upstream.
 */
export const mcpUserConfigSchema = z.object({
  upstreams: z.record(z.string().min(1), mcpUpstreamSchema).default({}),
});

/** See {@link mcpUserConfigSchema}. */
export type McpUserConfig = z.infer<typeof mcpUserConfigSchema>;

/**
 * Per-server entry in a project's `plugins.mcp.servers` list. The bare
 * string form (`"linear"`) accepts every tool the upstream exposes; the
 * object form constrains the guest to `tools` only — anything else
 * upstream offers is hidden from `tools/list` and refused at
 * `tools/call`.
 *
 * `tools: undefined` (or the bare-string form) means "all tools";
 * `tools: []` means "no tools" (advertising the server but allowing
 * nothing through). The empty-list form is useful to keep a server
 * connected (e.g. for OAuth scope) while temporarily disabling it.
 */
const serverEntrySchema = z.union([
  z.string().regex(/^[a-z0-9][a-z0-9-]*$/i),
  z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i),
    tools: z.array(z.string().min(1)).optional(),
  }),
]);

/** See {@link mcpProjectConfigSchema}. */
export type McpServerEntry = z.infer<typeof serverEntrySchema>;

/**
 * Canonical form of a project-declared server entry. The schema accepts
 * a bare-string shorthand for "all tools enabled"; {@link normalizeServerEntries}
 * folds both forms into this representation so downstream code only ever
 * sees one shape.
 */
export interface CanonicalServerEntry {
  name: string;
  /** `undefined` means "every tool the upstream exposes". */
  tools: readonly string[] | undefined;
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
});

/** See {@link mcpProjectConfigSchema}. */
export type McpProjectConfig = z.infer<typeof mcpProjectConfigSchema>;

/**
 * Normalize the heterogeneous `servers` list into uniform
 * {@link CanonicalServerEntry} records. Call once at the boundary
 * (plugin `initialize`, gateway tenant rebuild) so downstream code never
 * branches on the union shape.
 */
export function normalizeServerEntries(
  entries: readonly McpServerEntry[],
): CanonicalServerEntry[] {
  return entries.map((entry) =>
    typeof entry === 'string'
      ? { name: entry, tools: undefined }
      : { name: entry.name, tools: entry.tools },
  );
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
 * Applies a per-upstream `clientName` override when configured. Must
 * match what `mcp login` registered, otherwise the SDK's `auth()` helper
 * re-registers the client on every refresh.
 */
export function sidecarOAuthClientMetadata(
  upstream: McpUpstreamConfig,
): OAuthClientMetadata {
  return {
    ...BASE_OAUTH_CLIENT_METADATA,
    ...(upstream.clientName ? { client_name: upstream.clientName } : {}),
    redirect_uris: [SIDECAR_OAUTH_REDIRECT_URI],
  };
}
