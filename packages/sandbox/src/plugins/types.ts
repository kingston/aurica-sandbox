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
 * Result of expanding a single plugin into low-level rules. `domains` and
 * `policies` shape the proxy allowlist; `commands` run post-lockdown;
 * `bootstrapScript` is concatenated into the pre-lockdown init script;
 * `projectInitCwdOverride` is the working directory the project-level init
 * hook (`setup-project.sh`) runs from.
 *
 * Environment variables for the project (e.g. `AURICA_PROJECT_DIR`) are
 * not passed here — plugins emit a root `PluginCommand` to write them into
 * `/etc/environment`, which makes them visible to every PAM-launched shell
 * (init hooks included) instead of being scoped to a single invocation.
 *
 * `bootstrapScript`, when set, is a shell snippet that runs as root with the
 * network open (before the iptables lockdown). It's trusted code shipped in
 * the sandbox tool's source, so plugin authors own its safety — but inputs
 * interpolated into it (e.g. the linux user name) must be validated first
 * via {@link assertSafeShellIdent} or equivalent.
 *
 * At most one plugin per sandbox may set `projectInitCwdOverride` — the
 * project concept is singular and `expandPlugins` throws on conflict.
 */
export interface ExpandedPlugin {
  domains: string[];
  policies: ProxyPolicy[];
  commands: PluginCommand[];
  bootstrapScript?: string;
  projectInitCwdOverride?: string;
}

/**
 * Context passed to plugin expanders. `user` is the linux user inside the VM
 * (validated to be a safe shell identifier — plugins can interpolate it
 * directly into bootstrap scripts).
 */
export interface PluginExpansionContext {
  user: string;
}
