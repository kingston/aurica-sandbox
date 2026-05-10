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
 * actions, and in-VM init commands that wire git credentials.
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
 * Credentials are written to `~/.git-credentials` so other tools in the VM
 * (gh CLI, custom scripts) can read them, with `credential.helper = store`
 * and `credential.useHttpPath = true` so git matches per repo path rather
 * than per host. The placeholder lands inside an `Authorization: Basic
 * <base64(username:placeholder)>` header on the wire; the proxy rule uses a
 * `base64` transform with the same `username:` prefix so it can match the
 * encoded blob and substitute `base64(username:realToken)` at request time.
 *
 * The `~/.git-credentials` write truncates the file so re-running init is
 * idempotent. If a sandbox config ever has multiple github plugins, the
 * last-emitted plugin's command would clobber earlier ones — config
 * validation should reject that case (out of scope here).
 *
 * All actions for one plugin share `placeholder`, so the resolver only
 * needs to know which plugin the placeholder belongs to.
 */
export function expandGithub(
  plugin: GithubPlugin,
  placeholder: string,
): ExpandedPlugin {
  const actions: ProxyAction[] = [];
  const credentialUrls: string[] = [];

  const transform = {
    type: 'base64' as const,
    prefix: `${plugin.username}:`,
  };

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
        transform,
      },
      {
        domain: 'api.github.com',
        pathPrefix: `/repos${repoPath}`,
        hook: 'replaceApiKey',
        header: 'Authorization',
        placeholderValue: placeholder,
        replacementValue: plugin.token,
        transform,
      },
      {
        domain: 'codeload.github.com',
        pathPrefix: repoPath,
        hook: 'replaceApiKey',
        header: 'Authorization',
        placeholderValue: placeholder,
        replacementValue: plugin.token,
        transform,
      },
    );

    credentialUrls.push(
      `https://${plugin.username}:${placeholder}@github.com${repoPath}`,
    );
  }

  const commands: PluginCommand[] = [
    {
      user: 'default',
      argv: ['git', 'config', '--global', 'credential.helper', 'store'],
    },
    {
      user: 'default',
      argv: ['git', 'config', '--global', 'credential.useHttpPath', 'true'],
    },
    {
      user: 'default',
      argv: [
        'sh',
        '-c',
        // umask 0600s the file on creation; truncating each init makes the
        // operation idempotent. URLs come in via "$@" so the placeholder is
        // never interpolated into the script body.
        String.raw`umask 077 && printf "%s\n" "$@" > "$HOME/.git-credentials"`,
        'sh',
        ...credentialUrls,
      ],
    },
  ];

  return {
    domains: [...GITHUB_DOMAINS],
    actions,
    commands,
  };
}
