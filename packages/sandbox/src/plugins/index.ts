import { randomBytes } from 'node:crypto';

import type { ProxyAction } from '#src/config/proxy-action.js';

import { expandDocker } from './providers/docker.js';
import { expandGithub } from './providers/github.js';
import { expandMise } from './providers/mise.js';
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
 * Mint a placeholder string unique to one plugin. The proxy uses
 * `(host, header, placeholder)` to dispatch substitutions, so colliding
 * placeholders across plugins would cause one resolver to clobber another.
 * 8 random bytes (16 hex chars) is plenty.
 */
function mintPlaceholder(): string {
  return `__AURICA_TOKEN_${randomBytes(8).toString('hex').toUpperCase()}__`;
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
  actions: ProxyAction[];
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
  const actions: ProxyAction[] = [];
  const commands: PluginCommand[] = [];
  const bootstrapSnippets: string[] = [];

  for (const plugin of plugins) {
    const placeholder = mintPlaceholder();
    const expanded = expandPlugin(plugin, placeholder, ctx);
    for (const d of expanded.domains) domains.add(d);
    actions.push(...expanded.actions);
    commands.push(...expanded.commands);
    if (expanded.bootstrapScript) {
      bootstrapSnippets.push(expanded.bootstrapScript);
    }
  }

  return {
    domains: [...domains],
    actions,
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
