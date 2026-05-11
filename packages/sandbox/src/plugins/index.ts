import { createHash } from 'node:crypto';

import type { ProxyPolicy } from '#src/config/proxy-policy.js';

import { expandClaudeCode } from './claude-code/index.js';
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
  claudeCodePluginSchema,
  dockerPluginSchema,
  githubPluginSchema,
  misePluginSchema,
  pluginSchema,
} from './schema.js';
export type {
  ClaudeCodePlugin,
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
 *
 * `projectInitCwdOverride` is the working directory for the project-level
 * init hook (`setup-project.sh`) contributed by a plugin (today: github,
 * when at least one repo opts into `checkout: true`). At most one plugin
 * may contribute one — `expandPlugins` throws on conflict, because "the
 * project we're working on" is conceptually singular and a merge would
 * mask a real configuration error.
 */
export interface ExpandedPlugins {
  domains: string[];
  policies: ProxyPolicy[];
  commands: PluginCommand[];
  bootstrapScript: string;
  projectInitCwdOverride?: string;
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
 *
 * Throws when more than one plugin contributes a `projectInitCwdOverride`
 * — the project layer is singular by design, so a conflict is a
 * configuration error the user should resolve in `sandbox.json`.
 */
export function expandPlugins(
  plugins: readonly Plugin[],
  ctx: PluginExpansionContext,
): ExpandedPlugins {
  const domains = new Set<string>();
  const policies: ProxyPolicy[] = [];
  const commands: PluginCommand[] = [];
  const bootstrapSnippets: string[] = [];
  let projectInitCwdOverride: string | undefined;

  for (const plugin of plugins) {
    const placeholder = placeholderFor(plugin);
    const expanded = expandPlugin(plugin, placeholder, ctx);
    for (const d of expanded.domains) domains.add(d);
    policies.push(...expanded.policies);
    commands.push(...expanded.commands);
    if (expanded.bootstrapScript) {
      bootstrapSnippets.push(expanded.bootstrapScript);
    }
    if (expanded.projectInitCwdOverride !== undefined) {
      if (projectInitCwdOverride !== undefined) {
        throw new Error(
          `multiple plugins contributed a projectInitCwdOverride (existing=${projectInitCwdOverride}, new=${expanded.projectInitCwdOverride}). At most one plugin may define the project-level init cwd per sandbox.`,
        );
      }
      projectInitCwdOverride = expanded.projectInitCwdOverride;
    }
  }

  return {
    domains: [...domains],
    policies,
    commands,
    bootstrapScript: bootstrapSnippets.join('\n\n'),
    ...(projectInitCwdOverride !== undefined ? { projectInitCwdOverride } : {}),
  };
}

function expandPlugin(
  plugin: Plugin,
  placeholder: string,
  ctx: PluginExpansionContext,
): ExpandedPlugin {
  switch (plugin.type) {
    case 'github': {
      return expandGithub(plugin, placeholder, ctx);
    }
    case 'docker': {
      return expandDocker(plugin, ctx);
    }
    case 'mise': {
      return expandMise(plugin, ctx);
    }
    case 'claude-code': {
      return expandClaudeCode(plugin, placeholder, ctx);
    }
  }
}
