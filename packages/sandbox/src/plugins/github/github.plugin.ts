import type {
  MatcherEntry,
  Mutation,
  ProxyPolicy,
  ProxyPolicyTransform,
} from '#src/config/proxy-policy.js';
import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

import type { PluginCommand, SandboxPlugin } from '../types.js';
import {
  type GithubProjectConfig,
  type GithubUserIdentity,
  githubProjectConfigSchema,
  githubUserConfigSchema,
} from './schema.js';

/**
 * Hosts that github traffic reaches without per-repo authentication.
 * `*.githubusercontent.com` is content-addressed (hashes / package mirrors),
 * so per-repo scoping isn't meaningful. `cli.github.com` is only reached
 * during pre-lockdown bootstrap and package resolution.
 *
 * `github.com`, `api.github.com`, and `codeload.github.com` are covered by
 * allow policies, so they don't need to appear here.
 */
const GITHUB_DOMAINS = ['*.githubusercontent.com', 'cli.github.com'] as const;

/**
 * Absolute path to the custom git credential helper installed by this
 * plugin's bootstrap. We point `credential.helper` at this path instead of
 * the built-in `store` so failed auth attempts can't erase the user's
 * `~/.git-credentials` (the helper's `erase` verb is a no-op).
 */
const CREDENTIAL_HELPER_PATH = '/usr/local/bin/aurica-git-credential';

/**
 * Pre-lockdown shell snippet that installs the GitHub CLI from its official
 * apt repo and drops a custom git credential helper at
 * {@link CREDENTIAL_HELPER_PATH}.
 *
 * The credential helper delegates `get` to `git credential-store --file
 * ~/.git-credentials get` (so we keep git's URL/path matcher and honour
 * `credential.useHttpPath`), but treats `store` and `erase` as no-ops. Why:
 * `credential.helper store` deletes lines from `~/.git-credentials` when the
 * remote returns 401 — a misfiring proxy or expired token would otherwise
 * silently wipe the user's credentials and force a sandbox re-init. Aurica
 * owns the file (rewritten on every init); git must not mutate it.
 *
 * The heredoc terminator is single-quoted so `$HOME` and `$1` inside the
 * helper are written literally (not expanded by the bootstrap shell).
 *
 * Mirrors the shape of the docker plugin's bootstrap: curl the keyring
 * directly to /etc/apt/keyrings, write the sources file, then apt-get
 * install.
 */
const GH_CLI_BOOTSTRAP_SCRIPT = `# github plugin: install the GitHub CLI from the official cli.github.com apt repo.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg

ARCH=$(dpkg --print-architecture)
echo "deb [arch=\${ARCH} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list

apt-get update -y
apt-get install -y --no-install-recommends gh

# github plugin: install custom git credential helper. See JSDoc on
# GH_CLI_BOOTSTRAP_SCRIPT for why we don't use \`credential.helper store\`.
cat > ${CREDENTIAL_HELPER_PATH} <<'AURICA_GIT_CREDENTIAL_HELPER_EOF'
#!/bin/sh
# Aurica sandbox custom git credential helper.
# - get: delegate to git credential-store so per-host/path scoping still works
# - store/erase: no-op so the user's ~/.git-credentials is never mutated
case "$1" in
  get) exec git credential-store --file "$HOME/.git-credentials" get ;;
  store|erase) exit 0 ;;
  *) exit 0 ;;
esac
AURICA_GIT_CREDENTIAL_HELPER_EOF
chmod 0755 ${CREDENTIAL_HELPER_PATH}`;

/**
 * GitHub auth plugin. `repositories` lists the `<owner>/<repo>` pairs the
 * token should be attached to. Path-scoping at the proxy + per-repo entries
 * in `~/.git-credentials` (with `credential.useHttpPath = true`) together
 * ensure the token is only sent to those specific repos.
 *
 * Each repo defaults to allowing fetch + push over git smart-HTTP; setting
 * `readOnly: true` drops `git-receive-pack` so push is denied at the proxy.
 *
 * Every listed repository is cloned into `/workspaces/<repo>` inside the
 * VM during init. The first entry in `repositories[]` is treated as the
 * **primary** repo: the project-level init hook (`setup-project.sh`) runs
 * with its cwd set to the primary repo path, and `AURICA_PROJECT_DIR` is
 * written into `/etc/environment` so every PAM-launched shell sees it.
 *
 * `api` (plugin-level, default `false`) controls whether the configured
 * token is attached to `api.github.com` traffic. `api.github.com` is always
 * reachable through the proxy — the flag only governs authentication:
 *
 * - `api: true` attaches the token to every request, opening the
 *   token-scoped API surface (including `/graphql`). This is a deliberate
 *   bypass of repo scoping for the API — GraphQL POSTs encode repo identity
 *   in the request body rather than the URL, so the proxy can't constrain
 *   them per-repo; the token is trusted to enforce that. Disallowed in
 *   combination with `tokenSource: gh-token`, since the gh CLI's token
 *   typically lacks the scopes that make this useful.
 * - `api: false` (the default) lets requests through unauthenticated, so
 *   tools that only need public endpoints (e.g. mise resolving release
 *   versions) keep working without granting the token broad API scope.
 *   Subject to GitHub's anonymous rate limit (60/hr/IP).
 *
 * `username` is the credential username embedded in `~/.git-credentials`
 * URLs (`https://<username>:<token>@github.com/...`). For GitHub PATs and
 * app installation tokens the conventional value is `x-access-token`, but
 * any non-empty string is accepted. May come from user-level
 * `defaultUsername` when omitted at the project level.
 *
 * `user` (optional) sets the VM's global git committer identity. May come
 * from user-level `defaultUser` when omitted at the project level.
 *
 * `tokenSource` is a credential-source string parseable by
 * `parseCredentialSource`. Supported schemes: `env:<VAR>` and `gh-token`.
 * May come from user-level `defaultTokenSource` when omitted at the
 * project level.
 */
export const githubPlugin: SandboxPlugin<
  typeof githubUserConfigSchema,
  typeof githubProjectConfigSchema
> = {
  name: 'github',
  projectConfigSchema: githubProjectConfigSchema,
  userConfigSchema: githubUserConfigSchema,
  initialize({ project, user, generatePlaceholder, linuxUser }) {
    // The clone destination paths are interpolated as argv (not shell), so
    // they are not vulnerable to shell metacharacters, but we still validate
    // the linux user for consistency with the other plugins and to keep the
    // home-directory path predictable.
    assertSafeShellIdent('linuxUser', linuxUser);

    const username = project.username ?? user?.defaultUsername;
    if (!username) {
      throw new Error(
        'github plugin: `username` must be set on the project config or as `defaultUsername` on the user-level config.',
      );
    }
    const tokenSource = project.tokenSource ?? user?.defaultTokenSource;
    if (!tokenSource) {
      throw new Error(
        'github plugin: `tokenSource` must be set on the project config or as `defaultTokenSource` on the user-level config.',
      );
    }
    const gitUser = project.user ?? user?.defaultUser;

    // Single token covers both the git basic-auth password (over HTTPS to
    // github.com/codeload.github.com) and the `gh` CLI's `oauth_token` in
    // `~/.config/gh/hosts.yml`. Both substitute to the same upstream
    // credential — splitting them would just produce two placeholders that
    // resolve identically.
    const placeholder = generatePlaceholder('token');

    const policies: ProxyPolicy[] = [];
    const credentialUrls: string[] = [];

    const transform: ProxyPolicyTransform = {
      type: 'base64',
      prefix: `${username}:`,
    };
    const mutations = authMutations(placeholder, tokenSource, transform);

    for (const repo of project.repositories) {
      // Schema regex guarantees `<owner>/<repo>` shape, so split always yields
      // two non-empty strings.
      const [owner, name] = repo.name.split('/') as [string, string];

      policies.push(
        gitHostPolicyFor(
          repo.name,
          owner,
          name,
          repo.readOnly === true,
          mutations,
        ),
        codeloadPolicyFor(repo.name, owner, name, mutations),
      );

      // Write both URL forms (bare and `.git`-suffixed). With
      // `credential.useHttpPath = true`, git credential-store matches the
      // stored URL's path against the request's path exactly — so a clone of
      // `<owner>/<repo>.git` won't find an entry stored under
      // `<owner>/<repo>`. Our checkout uses the `.git` form, but user scripts
      // inside the VM may clone with either, so we store both.
      credentialUrls.push(
        `https://${username}:${placeholder}@github.com/${repo.name}`,
        `https://${username}:${placeholder}@github.com/${repo.name}.git`,
      );
    }

    if (project.api === true) {
      // Open all of api.github.com — GraphQL POSTs encode repo identity in
      // the body, so per-repo scoping at the proxy isn't meaningful for the
      // API surface. The configured token is trusted to enforce repo scope.
      policies.push({
        id: 'github:api:api.github.com',
        description: 'GitHub API access (token-scoped, including /graphql)',
        domain: 'api.github.com',
        action: { type: 'allow', mutations },
      });
    } else {
      // No token attached, but let requests through — tools like mise hit
      // `api.github.com/repos/<owner>/<repo>/releases` for version
      // resolution and only need anonymous access (subject to GitHub's
      // 60/hr/IP unauthenticated rate limit).
      policies.push({
        id: 'github:api:passthrough:api.github.com',
        description: 'GitHub API anonymous passthrough (no token attached)',
        domain: 'api.github.com',
        action: { type: 'allow' },
      });
    }

    // Every listed repo is cloned. The first entry is the primary repo —
    // `setup-project.sh` runs inside its directory and `AURICA_PROJECT_DIR`
    // points at it via `/etc/environment`. The schema requires at least one
    // repository, so `primary` is always defined; guard for the type system.
    const primary = project.repositories[0];
    if (!primary) {
      throw new Error('github plugin: repositories[] must be non-empty');
    }
    const [, primaryName] = primary.name.split('/') as [string, string];
    const projectDir = `/workspaces/${primaryName}`;

    const commands: PluginCommand[] = [
      {
        user: 'default',
        argv: [
          'git',
          'config',
          '--global',
          'credential.helper',
          CREDENTIAL_HELPER_PATH,
        ],
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
      ...(project.api === true
        ? [ghHostsYamlCommand(username, placeholder)]
        : []),
      ...userIdentityCommands(gitUser),
      ...checkoutCommands(project.repositories),
      etcEnvironmentProjectDirCommand(projectDir),
    ];

    return {
      domains: [...GITHUB_DOMAINS],
      policies,
      commands,
      bootstrapScript: GH_CLI_BOOTSTRAP_SCRIPT,
      projectInitCwdOverride: projectDir,
    };
  },
};

/**
 * Allow policy for git smart-HTTP on `github.com` covering fetch
 * (`info/refs` GET + `git-upload-pack` POST). Push (`git-receive-pack`
 * POST) is added unless `readOnly` is set.
 *
 * Each request path is matched in both its bare (`/<owner>/<repo>/...`) and
 * `.git`-suffixed (`/<owner>/<repo>.git/...`) form. GitHub accepts either
 * shape on the wire, and the suffix is preserved verbatim from the clone
 * URL — our own checkout uses `<owner>/<repo>.git`, so without the
 * suffixed variant the catch-all block fires before any fetch can happen.
 */
function gitHostPolicyFor(
  repoName: string,
  owner: string,
  name: string,
  readOnly: boolean,
  mutations: Mutation[],
): ProxyPolicy {
  const matchers: MatcherEntry[] = [
    { exact: `/${owner}/${name}/info/refs`, methods: ['GET'] },
    { exact: `/${owner}/${name}.git/info/refs`, methods: ['GET'] },
    { exact: `/${owner}/${name}/git-upload-pack`, methods: ['POST'] },
    { exact: `/${owner}/${name}.git/git-upload-pack`, methods: ['POST'] },
  ];
  if (!readOnly) {
    matchers.push(
      {
        exact: `/${owner}/${name}/git-receive-pack`,
        methods: ['POST'],
      },
      {
        exact: `/${owner}/${name}.git/git-receive-pack`,
        methods: ['POST'],
      },
    );
  }
  return {
    id: `github:${repoName}:github.com`,
    description: `GitHub git smart-HTTP for ${repoName}${readOnly ? ' (read-only)' : ''}`,
    domain: 'github.com',
    matchers,
    action: { type: 'allow', mutations },
  };
}

/**
 * Allow policy for archive downloads on `codeload.github.com`. Codeload
 * responds to GETs only, so `readOnly` doesn't change anything here — the
 * policy is the same shape regardless.
 */
function codeloadPolicyFor(
  repoName: string,
  owner: string,
  name: string,
  mutations: Mutation[],
): ProxyPolicy {
  return {
    id: `github:${repoName}:codeload.github.com`,
    description: `GitHub archive downloads for ${repoName}`,
    domain: 'codeload.github.com',
    matchers: [{ prefix: `/${owner}/${name}`, methods: ['GET'] }],
    action: { type: 'allow', mutations },
  };
}

/**
 * Two mutations on the same `Authorization` header. The first matches the
 * base64-encoded form git uses for HTTP Basic; the second matches gh's
 * plaintext `token <X>` form. Substring substitution is no-op when `from`
 * isn't present, so running both in order is safe — only the matching one
 * fires per request.
 */
function authMutations(
  placeholder: string,
  tokenSource: string,
  transform: ProxyPolicyTransform,
): Mutation[] {
  return [
    {
      kind: 'replace-header',
      header: 'Authorization',
      from: placeholder,
      to: tokenSource,
      transform,
    },
    {
      kind: 'replace-header',
      header: 'Authorization',
      from: placeholder,
      to: tokenSource,
    },
  ];
}

/**
 * Pre-authenticate the gh CLI by writing `~/.config/gh/hosts.yml` with the
 * placeholder as `oauth_token`. Run as the default user so the file lands
 * in their home with correct ownership.
 *
 * Only called when the plugin's `api: true` — see {@link githubPlugin} for
 * why writing this file with `api: false` would leak the placeholder.
 *
 * The YAML body is passed through `printf "%s\n" "$@"` so the placeholder
 * never gets interpolated by the wrapping shell.
 */
function ghHostsYamlCommand(
  username: string,
  placeholder: string,
): PluginCommand {
  // gh expects four-space indents under the host key.
  const lines = [
    'github.com:',
    `    user: ${username}`,
    `    oauth_token: ${placeholder}`,
    '    git_protocol: https',
  ];
  return {
    user: 'default',
    argv: [
      'sh',
      '-c',
      // mkdir is idempotent; truncating the file makes init re-runs clean.
      // umask 077 keeps perms tight on the credential file.
      String.raw`mkdir -p "$HOME/.config/gh" && umask 077 && printf "%s\n" "$@" > "$HOME/.config/gh/hosts.yml"`,
      'sh',
      ...lines,
    ],
  };
}

/**
 * One `git clone` command per repository in the plugin's `repositories[]`.
 * Each command runs as the default user post-lockdown, cloning to
 * `/workspaces/<repo>` over the existing per-repo proxy allow policies.
 * The URL is the bare `https://github.com/<owner>/<repo>.git` — auth
 * comes from the credential helper + `~/.git-credentials` that init has
 * already written, so `.git/config`'s `remote.origin.url` never carries
 * the placeholder.
 *
 * The `/workspaces` parent is created (and chowned to the default user)
 * by the built-in init script before iptables lockdown — see
 * `createInitShell`. These commands run as the default user and assume
 * the parent is already writable.
 *
 * Idempotent: `test -d "<dest>/.git" || git clone …` short-circuits when
 * the repo is already present, so re-running `aurica-sandbox init` is a
 * no-op for already-checked-out repos.
 */
function checkoutCommands(
  repos: readonly GithubProjectConfig['repositories'][number][],
): PluginCommand[] {
  return repos.map((repo) => {
    const [, repoName] = repo.name.split('/') as [string, string];
    const url = `https://github.com/${repo.name}.git`;
    const dest = `/workspaces/${repoName}`;
    return {
      user: 'default',
      argv: [
        'sh',
        '-c',
        // URL and dest passed as positional args ($1, $2) so neither lands
        // in the script body. /workspaces itself is created by the
        // built-in init; we don't need to mkdir its parent.
        'test -d "$2/.git" || git clone "$1" "$2"',
        'sh',
        url,
        dest,
      ],
    };
  });
}

/**
 * Append `AURICA_PROJECT_DIR=<path>` to `/etc/environment` so interactive
 * shells (including future `orb -m <name>` logins) see the variable via
 * PAM. Runs as root post-lockdown — `/etc/environment` was created by the
 * built-in init script in step 4 with the proxy env vars; we add one line
 * to it.
 *
 * Idempotent across init re-runs: removes any prior `AURICA_PROJECT_DIR=`
 * line before appending the new one. The path is passed as `$1` so it's
 * never interpolated into the script body.
 */
function etcEnvironmentProjectDirCommand(projectDir: string): PluginCommand {
  return {
    user: 'root',
    argv: [
      'sh',
      '-c',
      [
        'sed -i "/^AURICA_PROJECT_DIR=/d" /etc/environment',
        String.raw`printf "AURICA_PROJECT_DIR=%s\n" "$1" >> /etc/environment`,
      ].join(' && '),
      'sh',
      projectDir,
    ],
  };
}

/**
 * Mirror the resolved `user.name` / `user.email` into the VM's global git
 * config so commits inside the sandbox carry the configured identity.
 * Returns an empty list when no identity was resolved — `user` is optional
 * on both project and user-level configs.
 */
function userIdentityCommands(
  user: GithubUserIdentity | undefined,
): PluginCommand[] {
  if (!user) return [];
  return [
    {
      user: 'default',
      argv: ['git', 'config', '--global', 'user.name', user.name],
    },
    {
      user: 'default',
      argv: ['git', 'config', '--global', 'user.email', user.email],
    },
  ];
}
