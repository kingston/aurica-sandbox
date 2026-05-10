import { createHash } from 'node:crypto';

import type { ProxyPolicy } from '#src/config/proxy-policy.js';

import { expandDocker } from './docker/index.js';
import { expandGithub } from './github/index.js';
import { expandMise } from './mise/index.js';
import type { Plugin } from './schema.js';
import type {
  ExpandedPlugin,
  PluginCommand,
  PluginExpansionContext,
} from './types.js';

export {
  dockerPluginSchema,
  githubPluginSchema,
  misePluginSchema,
  pluginSchema,
} from './schema.js';
export type {
  DockerPlugin,
  GithubPlugin,
  MisePlugin,
  Plugin,
} from './schema.js';
export type {
  ExpandedPlugin,
  PluginCommand,
  PluginExpansionContext,
} from './types.js';

/**
 * Domains contributed by a single plugin for the purpose of the
 * `git.url` host-coverage validator. Only `github` plugins contribute here —
 * docker/mise hosts have no relationship to git URLs and would falsely
 * "cover" a github URL otherwise.
 */
export function pluginDomainsForGitCoverage(plugin: Plugin): string[] {
  if (plugin.type !== 'github') return [];
  return ['github.com', 'api.github.com', 'codeload.github.com'];
}

/**
 * Derive a placeholder string from a plugin's config. The proxy uses
 * `(host, header, placeholder)` to dispatch substitutions, so colliding
 * placeholders across plugins would cause one resolver to clobber another.
 *
 * The placeholder MUST be deterministic: the value is baked into the VM at
 * create-time (e.g. `git config http.<url>.extraHeader`), and the proxy
 * re-derives rules from `.aurica/sandbox.json` on every reload. A random
 * placeholder would diverge between the two and break credential
 * substitution after the first reload.
 *
 * 16 hex chars (64 bits of SHA-256) is enough collision resistance for the
 * tiny set of plugins in any one sandbox.
 */
function placeholderFor(plugin: Plugin): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(plugin))
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `__AURICA_TOKEN_${digest}__`;
}

/**
 * Result of expanding the full plugin list.
 *
 * `bootstrapScript` is the concatenation of each contributing plugin's
 * snippet in config-declared order, with a blank-line separator. Empty
 * string when no plugin contributed one.
 */
export interface ExpandedPlugins {
  domains: string[];
  policies: ProxyPolicy[];
  commands: PluginCommand[];
  bootstrapScript: string;
}

/**
 * Expand all plugins to the merged set of proxy domains, proxy actions,
 * post-lockdown commands, and pre-lockdown bootstrap script. Domains are
 * deduped; actions, commands, and bootstrap snippets are concatenated in
 * input order.
 *
 * Each plugin gets its own freshly-minted placeholder, so multiple plugins
 * targeting the same host can coexist without colliding on the
 * `(host, header, placeholder)` tuple.
 */
export function expandPlugins(
  plugins: readonly Plugin[],
  ctx: PluginExpansionContext,
): ExpandedPlugins {
  const domains = new Set<string>();
  const policies: ProxyPolicy[] = [];
  const commands: PluginCommand[] = [];
  const bootstrapSnippets: string[] = [];

  for (const plugin of plugins) {
    const placeholder = placeholderFor(plugin);
    const expanded = expandPlugin(plugin, placeholder, ctx);
    for (const d of expanded.domains) domains.add(d);
    policies.push(...expanded.policies);
    commands.push(...expanded.commands);
    if (expanded.bootstrapScript) {
      bootstrapSnippets.push(expanded.bootstrapScript);
    }
  }

  return {
    domains: [...domains],
    policies,
    commands,
    bootstrapScript: bootstrapSnippets.join('\n\n'),
  };
}

function expandPlugin(
  plugin: Plugin,
  placeholder: string,
  ctx: PluginExpansionContext,
): ExpandedPlugin {
  switch (plugin.type) {
    case 'github': {
      return expandGithub(plugin, placeholder);
    }
    case 'docker': {
      return expandDocker(plugin, ctx);
    }
    case 'mise': {
      return expandMise(plugin, ctx);
    }
  }
}
