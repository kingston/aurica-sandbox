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
 * Project-level config for the `mcp` plugin.
 *
 * `servers` lists the names of upstream MCP servers (defined under the
 * user-level `plugins.mcp.upstreams` block) this sandbox is allowed to
 * reach. Cross-validation against the user-level catalog happens at
 * sandbox create / proxy reload time — an unknown name fails fast with
 * a clear error rather than being silently dropped.
 *
 * Each name must be a valid path segment (kebab-case, no slashes) so it
 * can be used verbatim in the gateway's path-based routing in Phase 2:
 * `https://aurica.mcp.internal/<server>/mcp` maps one-to-one to a name
 * in this list.
 */
export const mcpProjectConfigSchema = z.object({
  servers: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/i))
    .default([])
    .describe(
      'Names of upstream MCP servers (declared in user config) this sandbox may reach.',
    ),
});

/** See {@link mcpProjectConfigSchema}. */
export type McpProjectConfig = z.infer<typeof mcpProjectConfigSchema>;
