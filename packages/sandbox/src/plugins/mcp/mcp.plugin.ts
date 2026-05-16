import { logger } from '#src/logger.js';
import type { SandboxEntry } from '#src/state/index.js';

import type {
  CliCommandContext,
  InitializedPlugin,
  ProxySidecar,
  SandboxPlugin,
  SidecarContext,
} from '../types.js';
import { registerMcpCommands } from './cli/mcp-commands.js';
import { McpGateway, type TenantEntry } from './gateway/gateway.js';
import {
  mcpProjectConfigSchema,
  mcpUserConfigSchema,
  type McpProjectConfig,
} from './schema.js';

/**
 * MCP plugin.
 *
 * Phase 1 contributes:
 *  - `cliCommands`: `aurica-sandbox mcp login|list|logout`
 *  - `proxySidecar`: a loopback HTTP gateway that maintains a per-sandbox
 *    tenant table. Phase 2 will turn this into the request-relay path.
 *
 * `initialize` is intentionally a no-op contributor today — proxy
 * domains, policies, and in-VM commands all land with the Phase 2 work
 * that wires the guest's `~/.claude.json` through the host proxy's
 * URL-rewrite policy.
 */
export const mcpPlugin: SandboxPlugin<
  typeof mcpUserConfigSchema,
  typeof mcpProjectConfigSchema
> = {
  name: 'mcp',
  projectConfigSchema: mcpProjectConfigSchema,
  userConfigSchema: mcpUserConfigSchema,
  initialize(): InitializedPlugin {
    // Phase 2 will fill these in once the host-proxy `rewrite-url`
    // policy action and the `~/.claude.json` merge command land. For
    // now the plugin produces no in-VM config: the guest can't yet
    // route MCP traffic.
    return { domains: [], policies: [], commands: [] };
  },
  cliCommands(program, ctx: CliCommandContext): void {
    registerMcpCommands(program, ctx);
  },
  async proxySidecar(ctx: SidecarContext): Promise<ProxySidecar> {
    const gateway = new McpGateway({ host: '127.0.0.1' });
    const { port } = await gateway.listen();
    logger.info(`mcp-gateway http://127.0.0.1:${port}`);

    // Surface the bound port back into state so the Phase 2
    // URL-rewrite policy (and any external tooling like `mcp list`)
    // can find the gateway without re-binding. The proxy treats
    // `sidecars[name]` as opaque — only this plugin reads its own slot.
    await ctx.withState((state) => {
      if (state.proxy) {
        state.proxy.sidecars[MCP_PLUGIN_NAME] = {
          port,
        } satisfies McpSidecarState;
      }
    });

    // Subscribe to sandbox registration changes. The subscribe call
    // fires immediately with the current snapshot, so we don't need a
    // separate seeding step.
    const unsubscribe = ctx.sandboxes.subscribe((snapshot) => {
      void rebuildTenants(gateway, ctx.loadSandboxConfig, snapshot);
    });

    return {
      async stop() {
        unsubscribe();
        await gateway.close();
        await ctx.withState((state) => {
          if (state.proxy) {
            state.proxy.sidecars = Object.fromEntries(
              Object.entries(state.proxy.sidecars).filter(
                ([k]) => k !== MCP_PLUGIN_NAME,
              ),
            );
          }
        });
      },
    };
  },
};

/**
 * Shape of the `mcp` plugin's slot inside `state.proxy.sidecars`.
 * Re-parsed by readers (e.g. `mcp list`) because the framework stores
 * sidecar state as `unknown`.
 */
export interface McpSidecarState {
  port: number;
}

const MCP_PLUGIN_NAME = 'mcp';

/**
 * Refresh the gateway's tenant table from a sandbox snapshot. Each
 * sandbox's enabled-server list comes from its `.aurica/sandbox.json`
 * `plugins.mcp.servers`; a project that doesn't opt into the `mcp`
 * plugin contributes an empty list, which means no MCP traffic for
 * that sandbox is authenticated.
 *
 * Config-load failures are logged but never thrown — one bad project's
 * sandbox.json must not poison the whole gateway. The offending
 * sandbox simply contributes no tenant entry; its MCP traffic gets
 * `server-not-enabled` until the config is fixed.
 */
async function rebuildTenants(
  gateway: McpGateway,
  loadSandboxConfig: SidecarContext['loadSandboxConfig'],
  sandboxes: readonly SandboxEntry[],
): Promise<void> {
  const enabledByName = new Map<string, readonly string[]>();
  await Promise.all(
    sandboxes.map(async (sandbox) => {
      try {
        const cfg = await loadSandboxConfig(sandbox.projectDir);
        const mcp = (cfg.plugins as { mcp?: McpProjectConfig | undefined }).mcp;
        enabledByName.set(sandbox.name, mcp?.servers ?? []);
      } catch (err) {
        logger.error(
          `mcp-gateway: failed to load ${sandbox.name}'s sandbox.json: ${err instanceof Error ? err.message : String(err)}`,
        );
        enabledByName.set(sandbox.name, []);
      }
    }),
  );
  const tenants: TenantEntry[] = McpGateway.buildTenants(
    sandboxes,
    (sandbox) => enabledByName.get(sandbox.name) ?? [],
  );
  gateway.setTenants(tenants);
}
