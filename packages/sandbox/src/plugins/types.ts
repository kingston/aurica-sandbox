import type { z } from 'zod';

import type { ProxyPolicy } from '#src/config/proxy-policy.js';

/**
 * One command a plugin wants the orchestrator to run inside the VM after the
 * iptables lockdown — i.e. only the host proxy is reachable. argv-only (no
 * shell) keeps token-placeholder commands like
 * `git config http.<repo>.extraHeader 'Authorization: Bearer <PLACEHOLDER>'`
 * injection-safe.
 *
 * `user: 'root'` runs as root; `'default'` runs as the VM's default user. The
 * argv is passed straight to `VMExec.run`, so quoting in individual args is
 * preserved verbatim. Any tokens or secrets must be encoded as proxy
 * placeholder strings, never resolved values.
 */
export interface PluginCommand {
  user: 'root' | 'default';
  argv: string[];
}

/**
 * Result of initializing a single plugin: low-level rules the framework
 * merges into a sandbox-wide allowlist + command list.
 *
 * - `domains` shape the proxy host allowlist.
 * - `policies` carry credential-substitution actions (allow/block + mutations).
 * - `commands` run post-lockdown (only the host proxy is reachable).
 * - `bootstrapScript` runs as root pre-lockdown, with the network open.
 * - `projectInitCwdOverride` sets the working directory for the project-level
 *   init hook (`setup-project.sh`). At most one plugin may set this per
 *   sandbox — `expandPlugins` throws on conflict.
 *
 * Environment variables for the project (e.g. `AURICA_PROJECT_DIR`) are not
 * passed here — plugins emit a root `PluginCommand` to write them into
 * `/etc/environment`, which makes them visible to every PAM-launched shell
 * (init hooks included) instead of being scoped to a single invocation.
 *
 * `bootstrapScript`, when set, is trusted code shipped in the sandbox tool's
 * source — plugin authors own its safety. Inputs interpolated into it (e.g.
 * the linux user name) must be validated first via
 * {@link assertSafeShellIdent} or equivalent.
 */
export interface InitializedPlugin {
  domains: string[];
  policies: ProxyPolicy[];
  commands: PluginCommand[];
  bootstrapScript?: string;
  projectInitCwdOverride?: string;
}

/**
 * Resolved user-config type for a plugin. When the plugin declares no
 * `userConfigSchema`, the field is typed as `undefined`; otherwise it is the
 * schema's inferred type (which may itself be `undefined` if the user-level
 * config omits this plugin's defaults).
 */
type UserConfigOf<U> = U extends z.ZodType ? z.infer<U> | undefined : undefined;

/**
 * Context passed to a plugin's `initialize` function. The framework
 * supplies:
 *
 * - `project`     — the validated project-config block for this plugin.
 * - `user`        — the validated user-config block, or `undefined` when the
 *                   plugin declares no user schema or the user-level config
 *                   omits this plugin.
 * - `placeholder` — a deterministic per-plugin token the proxy uses for
 *                   credential substitution. Plugins that don't inject
 *                   credentials can ignore it.
 * - `linuxUser`   — the linux user inside the VM (already validated to be a
 *                   safe shell identifier, so plugins can interpolate it
 *                   directly into bootstrap scripts).
 */
export interface PluginInitContext<U, P extends z.ZodType> {
  project: z.infer<P>;
  user: UserConfigOf<U>;
  placeholder: string;
  linuxUser: string;
}

/**
 * Contract every plugin implements. The plugin registry collects these into
 * a single source of truth used to build the project/user config schemas,
 * iterate plugins at expansion time, and validate placeholder uniqueness.
 *
 * `name` is the key under which the plugin appears in the keyed config shape
 * (`config.plugins.<name>`), so it must be unique across the registry. It is
 * also the discriminator used to look up a plugin's section in both project
 * and user configs.
 *
 * `projectConfigSchema` is the strict schema applied to the project-level
 * config block. Plugins that take no project-level options use
 * `z.object({})`.
 *
 * `userConfigSchema` is optional. When set, the same plugin name in the
 * user-level config is validated against it. Plugins that need no user-level
 * defaults omit this field entirely. The framework still treats project
 * declaration as the opt-in: a user-level default never activates a plugin
 * the project did not opt into.
 *
 * `initialize` runs per-plugin at sandbox-create / proxy-reload time and
 * returns the low-level rules the framework merges across plugins.
 */
export interface SandboxPlugin<
  U extends z.ZodType | undefined = z.ZodType | undefined,
  P extends z.ZodType = z.ZodType,
> {
  name: string;
  projectConfigSchema: P;
  /**
   * Always present in the type — set to `undefined` when the plugin needs
   * no user-level defaults. Keeping the property required (rather than
   * optional) lets `Extract<…, { userConfigSchema: z.ZodType }>` cleanly
   * pick out the plugins that do declare a user schema.
   */
  userConfigSchema: U;
  initialize(ctx: PluginInitContext<U, P>): InitializedPlugin;
}
