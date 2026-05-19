import type { ProxyPolicy } from '#src/config/proxy-policy.js';
import { logger } from '#src/logger.js';
import type { SandboxEntry } from '#src/state/index.js';
import { errorMessage } from '#src/utils/error-message.js';

import { makeGeneratePlaceholder } from '../expand.js';
import type {
  CliCommandContext,
  InitializedPlugin,
  PluginCommand,
  PluginInitContext,
  ProxySidecar,
  SandboxPlugin,
  SidecarContext,
} from '../types.js';
import { registerMcpCommands } from './cli/mcp-commands.js';
import {
  McpForwarder,
  type UpstreamCatalog,
  type UpstreamCatalogEntry,
} from './gateway/forwarder.js';
import { McpGateway, type TenantEntry } from './gateway/gateway.js';
import {
  mcpProjectConfigSchema,
  mcpUserConfigSchema,
  normalizeServerEntries,
  readMcpUserConfig,
  sidecarOAuthClientMetadata,
  type CanonicalServerEntry,
  type McpProjectConfig,
  type McpUserConfig,
} from './schema.js';

/**
 * Synthetic host the guest's Claude Code uses to reach the on-host MCP
 * gateway. The `.internal` suffix has no DNS authority, which prevents
 * collision with any real upstream.
 */
const MCP_INTERNAL_DOMAIN = 'aurica.mcp.internal';

/**
 * Fixed loopback port for the MCP gateway. Chosen from the IANA
 * dynamic/private range, one above the proxy's `51_217`. Pinning the
 * port means the `rewrite-url` policy can hardcode the target — the
 * CLI `create` command runs in a separate process from the proxy, so
 * an OS-assigned port would need to round-trip through state.json.
 * A collision surfaces loudly from `gateway.listen()`, matching how
 * the proxy handles its own fixed port.
 */
const MCP_GATEWAY_PORT = 51_218;

/**
 * Plugin name. Used both as the registry key and as the namespace input
 * to the framework's placeholder hash, so the sidecar's `rebuildTenants`
 * and the in-process `initialize` derive the same per-sandbox bearer.
 */
const MCP_PLUGIN_NAME = 'mcp';

/**
 * MCP plugin. Exposes `aurica-sandbox mcp login|list|logout` and runs a
 * loopback MCP gateway that authenticates guest traffic and forwards
 * `tools/list` / `tools/call` to user-configured upstreams, filtering by
 * the per-sandbox tool ACL declared in `plugins.mcp.servers`.
 */
export const mcpPlugin: SandboxPlugin<
  typeof mcpUserConfigSchema,
  typeof mcpProjectConfigSchema
> = {
  name: MCP_PLUGIN_NAME,
  projectConfigSchema: mcpProjectConfigSchema,
  userConfigSchema: mcpUserConfigSchema,
  initialize(ctx): InitializedPlugin {
    return buildInitializedPlugin(ctx);
  },
  cliCommands(program, ctx: CliCommandContext): void {
    registerMcpCommands(program, ctx);
  },
  async proxySidecar(ctx: SidecarContext): Promise<ProxySidecar> {
    const forwarder = new McpForwarder();
    const gateway = new McpGateway({
      host: '127.0.0.1',
      port: MCP_GATEWAY_PORT,
      forwarder,
    });
    await gateway.listen();
    logger.info(`mcp-gateway http://127.0.0.1:${MCP_GATEWAY_PORT}`);

    // Refresh the upstream catalog on every tick: user config has no
    // dedicated watcher, and proxy reloads are when users typically
    // edit it. This lets `mcp login` for a new upstream take effect on
    // the next reload without restarting the proxy.
    //
    // Rebuilds are serialized via {@link runSerialized}: back-to-back
    // publishes (rapid create+destroy, or a watcher burst) could
    // otherwise interleave so the last-completed rebuild — not the
    // last-fired — wins.
    const scheduleRebuild = runSerialized(async () => {
      const snapshot = ctx.sandboxes.snapshot();
      await Promise.all([
        rebuildTenants(gateway, ctx.loadSandboxConfig, snapshot),
        rebuildUpstreamCatalog(forwarder, ctx.loadUserConfig),
      ]);
    });
    const unsubscribe = ctx.sandboxes.subscribe(() => {
      scheduleRebuild();
    });

    return {
      async stop() {
        unsubscribe();
        await gateway.close();
        await forwarder.close();
      },
    };
  },
};

/**
 * Build the per-sandbox rules from the plugin's project + user config.
 * For each enabled server the plugin emits:
 *
 * 1. A `rewrite-url` policy on `aurica.mcp.internal` that targets the
 *    loopback gateway on the fixed {@link MCP_GATEWAY_PORT}.
 * 2. A post-lockdown root command that adds `aurica.mcp.internal` to
 *    `/etc/hosts`.
 * 3. A post-lockdown command that merges entries into
 *    `~/.claude.json`'s `projects.<dir>.mcpServers` so Claude Code
 *    dispatches MCP traffic through the gateway.
 *
 * The `Authorization` bearer is a deterministic per-sandbox placeholder
 * derived from `generatePlaceholder('bearer')`. The gateway's tenant
 * table holds the same value (computed identically in the sidecar) and
 * authenticates incoming requests against it — so the sandbox's real
 * `authSecret` never lands on the guest filesystem.
 *
 * Yields no rules when `servers` is empty.
 */
function buildInitializedPlugin(
  ctx: PluginInitContext<
    typeof mcpUserConfigSchema,
    typeof mcpProjectConfigSchema
  >,
): InitializedPlugin {
  const servers = normalizeServerEntries(ctx.project.servers);
  if (servers.length === 0) {
    return { domains: [], policies: [], commands: [] };
  }

  // Every project-declared server must exist in the user-level upstream
  // catalog. Silently dropping unknown entries would leave the guest's
  // Claude Code attempting an unrouted call.
  const upstreams = ctx.user?.upstreams ?? {};
  for (const entry of servers) {
    if (!(entry.name in upstreams)) {
      throw new Error(
        `mcp plugin: project lists server ${JSON.stringify(entry.name)} but it is not declared under user-level plugins.mcp.upstreams`,
      );
    }
  }

  const bearer = ctx.generatePlaceholder('bearer');
  const serverNames = servers.map((s) => s.name);

  const policies: ProxyPolicy[] = serverNames.map((server) => ({
    id: `mcp:${server}`,
    description: `Route guest MCP traffic for ${server} through the on-host gateway`,
    domain: MCP_INTERNAL_DOMAIN,
    matchers: [{ prefix: `/${server}/mcp` }],
    action: {
      type: 'rewrite-url',
      target: `http://127.0.0.1:${MCP_GATEWAY_PORT}{path}`,
    },
  }));

  return {
    domains: [MCP_INTERNAL_DOMAIN],
    policies,
    commands: [
      registerInternalHostCommand(),
      mergeClaudeJsonCommand(serverNames, bearer),
    ],
  };
}

/**
 * Add `aurica.mcp.internal` to `/etc/hosts`, pointing at the in-VM
 * proxy IPv4. Sources `/etc/environment` for `$AURICA_HOST_IP` (written
 * by the built-in init script). When the host has no IPv4 the var is
 * absent and we skip the entry — v6-only environments come up without
 * MCP, since the transparent NAT is IPv4-only.
 */
function registerInternalHostCommand(): PluginCommand {
  // $AURICA_HOST_IP is loaded into the environment by PAM (the same path
  // that surfaces $HTTPS_PROXY etc.), so no explicit sourcing is needed.
  // `set -u` is intentionally off — an unset var is the success path for
  // v6-only setups, not an error.
  const script = String.raw`
set -e
if [ -n "$AURICA_HOST_IP" ]; then
  echo "$AURICA_HOST_IP ${MCP_INTERNAL_DOMAIN}" >> /etc/hosts
else
  echo "mcp: AURICA_HOST_IP not set; skipping /etc/hosts entry" >&2
fi
`;
  return { user: 'root', argv: ['sh', '-c', script] };
}

/**
 * Register each enabled MCP server with Claude Code's CLI via
 * `claude mcp add --transport http --scope local`. The CLI writes into
 * `~/.claude.json`'s `projects.<cwd>.mcpServers`, read-then-merge, so
 * sibling keys on the project entry (e.g. `hasTrustDialogAccepted`
 * seeded by the claude-code plugin) survive untouched.
 *
 * `bearer` is the deterministic per-sandbox placeholder the MCP gateway
 * uses as its tenant key — same value the gateway's sidecar computes
 * via the framework's `makeGeneratePlaceholder('mcp', authSecret)`.
 *
 * Runs as the `default` user; plugin commands aren't dispatched via a
 * login shell, so `claude` is invoked by absolute path
 * (`$HOME/.local/bin/claude`, where the official installer drops it)
 * rather than via `PATH`. `cd "$AURICA_PROJECT_DIR"` makes `--scope local`
 * key the entry under the same path the guest's Claude Code is later
 * launched from. `AURICA_PROJECT_DIR` is set in `/etc/environment` by the
 * built-in init and surfaced to non-login shells by PAM, so reading it
 * directly is reliable.
 *
 * Positional `<name> <url>` come **before** `--header`: claude's
 * `--header` is variadic (`<header...>`), so any positional args after
 * it get swallowed into the header list, leaving `<name>` unbound.
 *
 * Server names are constrained by {@link mcpProjectConfigSchema} to
 * `[a-z0-9][a-z0-9-]*` and the bearer placeholder to
 * `__AURICA_TOKEN_[A-F0-9]{16}__`, so passing them as positional `argv`
 * arguments is safe.
 */
function mergeClaudeJsonCommand(
  servers: readonly string[],
  bearer: string,
): PluginCommand {
  const script = String.raw`
set -eu
cd "$AURICA_PROJECT_DIR"
bearer="$1"
shift
for server in "$@"; do
  "$HOME/.local/bin/claude" mcp add --transport http --scope local "$server" "https://${MCP_INTERNAL_DOMAIN}/$server/mcp" --header "Authorization: Bearer $bearer"
done
`;
  return {
    user: 'default',
    argv: ['sh', '-c', script, 'sh', bearer, ...servers],
  };
}

/**
 * Refresh the gateway's tenant table from a sandbox snapshot, keyed on
 * each sandbox's `plugins.mcp.servers`. A config-load failure for any
 * one sandbox is logged and that sandbox contributes no tenant entry —
 * one bad sandbox.json must not poison the whole gateway.
 */
async function rebuildTenants(
  gateway: McpGateway,
  loadSandboxConfig: SidecarContext['loadSandboxConfig'],
  sandboxes: readonly SandboxEntry[],
): Promise<void> {
  const serversByName = new Map<string, readonly CanonicalServerEntry[]>();
  await Promise.all(
    sandboxes.map(async (sandbox) => {
      try {
        const cfg = await loadSandboxConfig(sandbox.projectDir);
        const mcp = (cfg.plugins as { mcp?: McpProjectConfig | undefined }).mcp;
        serversByName.set(
          sandbox.name,
          normalizeServerEntries(mcp?.servers ?? []),
        );
      } catch (err) {
        logger.error(
          `mcp-gateway: failed to load ${sandbox.name}'s sandbox.json: ${errorMessage(err)}`,
        );
        serversByName.set(sandbox.name, []);
      }
    }),
  );
  const tenants: TenantEntry[] = McpGateway.buildTenants(
    sandboxes,
    (sandbox) => serversByName.get(sandbox.name) ?? [],
    (sandbox) =>
      makeGeneratePlaceholder(MCP_PLUGIN_NAME, sandbox.authSecret)('bearer'),
  );
  gateway.setTenants(tenants);
}

/**
 * Refresh the forwarder's upstream catalog from the user-level
 * `plugins.mcp.upstreams` block. On config-load failure the catalog is
 * cleared and every MCP request gets a structured "no upstream" error
 * until the config is fixed — a malformed user config must not bring
 * the gateway down.
 */
async function rebuildUpstreamCatalog(
  forwarder: McpForwarder,
  loadUserConfig: SidecarContext['loadUserConfig'],
): Promise<void> {
  let mcp: McpUserConfig;
  try {
    const userConfig = await loadUserConfig();
    mcp = readMcpUserConfig(userConfig);
  } catch (err) {
    logger.error(
      `mcp-gateway: failed to load user config: ${errorMessage(err)}`,
    );
    forwarder.setCatalog(new Map());
    return;
  }
  const catalog = new Map<string, UpstreamCatalogEntry>();
  for (const [name, def] of Object.entries(mcp.upstreams)) {
    catalog.set(name, {
      url: def.url,
      clientMetadata: sidecarOAuthClientMetadata(def),
    });
  }
  forwarder.setCatalog(catalog satisfies UpstreamCatalog);
}

/**
 * Wrap an async task so concurrent invocations collapse: only one run
 * is in flight at a time, and any invocations that arrive while a run
 * is active cause exactly one additional run to fire when the current
 * one settles. The returned function is fire-and-forget; errors thrown
 * by `task` are logged.
 *
 * Lets the sandbox-snapshot subscriber re-trigger a rebuild without
 * interleaving stale and fresh snapshots — the last-fired publish is
 * always observed by the final run.
 */
function runSerialized(task: () => Promise<void>): () => void {
  let running = false;
  let pending = false;
  const run = (): void => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    void task()
      .catch((err: unknown) => {
        logger.error(`mcp-gateway: rebuild failed: ${errorMessage(err)}`);
      })
      .finally(() => {
        running = false;
        if (pending) {
          pending = false;
          run();
        }
      });
  };
  return run;
}
