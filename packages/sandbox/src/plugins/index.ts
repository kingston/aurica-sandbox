import { createHash } from 'node:crypto';

import type { ProxyPolicy } from '#src/config/proxy-policy.js';

import { PLUGINS } from './registry.js';
import type { ProjectPlugins, UserPlugins } from './schema.js';
import type { PluginCommand } from './types.js';

export { PLUGINS } from './registry.js';
export { projectPluginsSchema, userPluginsSchema } from './schema.js';
export type {
  ClaudeCodeProjectConfig,
  CursorProjectConfig,
  DockerProjectConfig,
  GithubProjectConfig,
  GithubUserConfig,
  MiseProjectConfig,
  ProjectPlugins,
  UserPlugins,
} from './schema.js';
export type {
  InitializedPlugin,
  PluginCommand,
  PluginInitContext,
  SandboxPlugin,
} from './types.js';

/**
 * Hostname prefixes contributed by an active github plugin for the purpose
 * of the `git.url` host-coverage validator. Returns an empty array when
 * github isn't enabled.
 */
export function githubDomainsForGitCoverage(plugins: ProjectPlugins): string[] {
  if (!plugins.github) return [];
  return ['github.com', 'api.github.com', 'codeload.github.com'];
}

/**
 * Derive a placeholder string from a plugin's name + config. The proxy
 * uses `(host, header, placeholder)` to dispatch substitutions, so
 * colliding placeholders across plugins would cause one resolver to
 * clobber another.
 *
 * The placeholder MUST be deterministic: the value is baked into the VM
 * at create-time (e.g. `git config http.<url>.extraHeader`), and the
 * proxy re-derives rules from `.aurica/sandbox.json` on every reload. A
 * random placeholder would diverge between the two and break credential
 * substitution after the first reload.
 *
 * Hashing `{ name, config }` keeps placeholders unique across plugins
 * even when two plugins have empty configs (`{}`).
 *
 * 16 hex chars (64 bits of SHA-256) is enough collision resistance for
 * the tiny set of plugins in any one sandbox.
 */
function placeholderFor(name: string, config: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ name, config }))
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `__AURICA_TOKEN_${digest}__`;
}

/**
 * Result of expanding the full plugin set.
 *
 * `bootstrapScript` is the concatenation of each contributing plugin's
 * snippet in **registry-declared** order (not config-file key order),
 * with a blank-line separator. Empty string when no plugin contributed.
 *
 * `projectInitCwdOverride` is the working directory for the project-level
 * init hook (`setup-project.sh`) contributed by a plugin (today: github).
 * At most one plugin may contribute one — `expandPlugins` throws on
 * conflict.
 */
export interface ExpandedPlugins {
  domains: string[];
  policies: ProxyPolicy[];
  commands: PluginCommand[];
  bootstrapScript: string;
  projectInitCwdOverride?: string;
}

/** Context passed to `expandPlugins` and threaded into each plugin's init. */
export interface ExpandContext {
  linuxUser: string;
}

/**
 * Walk the registry in declared order; for each plugin that the project
 * config opted into, look up its user-config block, build the per-plugin
 * init context, and call `initialize`. Merge domains (deduped), policies,
 * commands, and bootstrap snippets across all activated plugins.
 *
 * The project layer is the opt-in: a user-level default never activates a
 * plugin the project did not declare under `plugins.<name>`.
 *
 * Throws when more than one plugin contributes a `projectInitCwdOverride`
 * — the project layer is singular by design.
 */
export function expandPlugins(
  projectPlugins: ProjectPlugins,
  userPlugins: UserPlugins,
  ctx: ExpandContext,
): ExpandedPlugins {
  const domains = new Set<string>();
  const policies: ProxyPolicy[] = [];
  const commands: PluginCommand[] = [];
  const bootstrapSnippets: string[] = [];
  let projectInitCwdOverride: string | undefined;

  for (const plugin of PLUGINS) {
    const projectConfig = (projectPlugins as Record<string, unknown>)[
      plugin.name
    ];
    if (projectConfig === undefined) continue;

    const userConfig = (userPlugins as Record<string, unknown>)[plugin.name];
    const placeholder = placeholderFor(plugin.name, projectConfig);

    const initialized = plugin.initialize({
      // The framework has already validated both blocks against the
      // plugin's schemas via `projectPluginsSchema` / `userPluginsSchema`,
      // so the casts here are sound — the plugin's `initialize` signature
      // is already correctly typed against its declared schemas.
      project: projectConfig as never,
      user: userConfig as never,
      placeholder,
      linuxUser: ctx.linuxUser,
    });

    for (const d of initialized.domains) domains.add(d);
    policies.push(...initialized.policies);
    commands.push(...initialized.commands);
    if (initialized.bootstrapScript) {
      bootstrapSnippets.push(initialized.bootstrapScript);
    }
    if (initialized.projectInitCwdOverride !== undefined) {
      if (projectInitCwdOverride !== undefined) {
        throw new Error(
          `multiple plugins contributed a projectInitCwdOverride (existing=${projectInitCwdOverride}, new=${initialized.projectInitCwdOverride}). At most one plugin may define the project-level init cwd per sandbox.`,
        );
      }
      projectInitCwdOverride = initialized.projectInitCwdOverride;
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
