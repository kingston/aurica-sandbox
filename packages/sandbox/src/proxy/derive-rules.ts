import type { ProxyAction, SandboxConfig } from '#src/config/index.js';
import {
  expandPlugins,
  type ExpandedPlugins,
  type Plugin,
} from '#src/plugins/index.js';

import {
  githubPluginFromGitConfig,
  nonGithubGitAction,
} from './git-actions.js';

/**
 * The proxy-relevant subset of a sandbox's rules: the host allowlist and the
 * credential-substitution actions. Everything else `expandPlugins` produces
 * (post-lockdown commands, pre-lockdown bootstrap script) is consumed at VM
 * create time, not at proxy reload time.
 */
export interface DerivedRules {
  domains: string[];
  actions: ProxyAction[];
}

/** Context required to expand plugins (e.g. the linux user inside the VM). */
export interface DerivationContext {
  user: string;
}

/**
 * Combined output of a full derivation: the proxy-relevant rules plus the
 * full plugin expansion. `runCreate` needs both halves; the proxy reload path
 * only needs `rules`.
 */
export interface FullDerivation extends ExpandedPlugins {
  rules: DerivedRules;
  /** The merged plugin list including any synthesized github plugin from `config.git`. */
  plugins: Plugin[];
}

/**
 * Derive the host allowlist and credential actions for a sandbox from its
 * `.aurica/sandbox.json` config. This is the single source of truth used by
 * both `runCreate` (initial registration) and the proxy's hot-reload path.
 *
 * Plugin placeholders are deterministic (see `placeholderFor` in
 * `plugins/index.ts`), so re-running this on every reload yields the same
 * action values that were baked into the VM at create time.
 */
export function deriveRulesFromConfig(
  config: SandboxConfig,
  ctx: DerivationContext,
): DerivedRules {
  return deriveFromConfig(config, ctx).rules;
}

/**
 * Same as {@link deriveRulesFromConfig} but returns the full plugin
 * expansion alongside the rules. Used by `runCreate`, which needs the
 * plugin commands and bootstrap script in addition to the proxy rules.
 */
export function deriveFromConfig(
  config: SandboxConfig,
  ctx: DerivationContext,
): FullDerivation {
  const syntheticGithubPlugin = githubPluginFromGitConfig(config.git);
  const fallbackGitAction = nonGithubGitAction(config.git);

  const plugins: Plugin[] = [
    ...config.plugins,
    ...(syntheticGithubPlugin ? [syntheticGithubPlugin] : []),
  ];
  const expanded = expandPlugins(plugins, { user: ctx.user });

  const domains = [...config.proxy.domains, ...expanded.domains];
  const actions: ProxyAction[] = [
    ...config.proxy.actions,
    ...expanded.actions,
    ...(fallbackGitAction ? [fallbackGitAction] : []),
  ];

  return {
    ...expanded,
    plugins,
    rules: { domains, actions },
  };
}
