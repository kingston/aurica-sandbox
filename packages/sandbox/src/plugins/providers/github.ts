import type { ProxyAction } from '#src/config/proxy-action.js';

import type { GithubPlugin } from '../schema.js';
import type { ExpandedPlugin, PluginCommand } from '../types.js';

/**
 * Hosts that github traffic legitimately reaches. All four are added to the
 * proxy allowlist so requests aren't 403'd; only the first three get
 * path-scoped auth actions (see `expandGithub` for why githubusercontent is
 * excluded from auth).
 */
const GITHUB_DOMAINS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  '*.githubusercontent.com',
] as const;

/**
 * Expand a single github plugin into proxy domains, path-scoped proxy
 * actions, and per-repo in-VM `git config` commands.
 *
 * Auth is attached only to specific `(host, pathPrefix)` pairs:
 *
 * - `github.com` + `/<owner>/<repo>` (covers `.git` suffix via prefix match)
 * - `api.github.com` + `/repos/<owner>/<repo>` (REST API for that repo)
 * - `codeload.github.com` + `/<owner>/<repo>` (archive downloads)
 *
 * `*.githubusercontent.com` is intentionally excluded from auth: paths there
 * are content hashes, not repo identifiers, so per-repo scoping isn't
 * meaningful. The host stays in `domains` so requests aren't blocked, but no
 * token is attached. v1 limitation; revisit if a use case appears.
 *
 * All actions for one plugin share `placeholder`, so the resolver only
 * needs to know which plugin the placeholder belongs to.
 */
export function expandGithub(
  plugin: GithubPlugin,
  placeholder: string,
): ExpandedPlugin {
  const actions: ProxyAction[] = [];
  const commands: PluginCommand[] = [];

  for (const repo of plugin.repositories) {
    // Schema regex guarantees `<owner>/<repo>` shape, so split always yields
    // two non-empty strings.
    const repoPath = `/${repo.name}`;

    actions.push(
      {
        domain: 'github.com',
        pathPrefix: repoPath,
        hook: 'replaceApiKey',
        header: 'Authorization',
        placeholderValue: placeholder,
        replacementValue: plugin.token,
      },
      {
        domain: 'api.github.com',
        pathPrefix: `/repos${repoPath}`,
        hook: 'replaceApiKey',
        header: 'Authorization',
        placeholderValue: placeholder,
        replacementValue: plugin.token,
      },
      {
        domain: 'codeload.github.com',
        pathPrefix: repoPath,
        hook: 'replaceApiKey',
        header: 'Authorization',
        placeholderValue: placeholder,
        replacementValue: plugin.token,
      },
    );

    commands.push({
      user: 'default',
      argv: [
        'git',
        'config',
        '--global',
        `http.https://github.com${repoPath}.extraHeader`,
        `Authorization: Bearer ${placeholder}`,
      ],
    });
  }

  return {
    domains: [...GITHUB_DOMAINS],
    actions,
    commands,
  };
}
