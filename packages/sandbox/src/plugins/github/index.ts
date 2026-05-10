import type {
  MatcherEntry,
  Mutation,
  ProxyPolicy,
  ProxyPolicyTransform,
} from '#src/config/index.js';

import type { ExpandedPlugin, PluginCommand } from '../types.js';
import {
  GITHUB_CAPABILITY_MAP,
  interpolateMatcher,
  type GithubAuthHost,
  type GithubCapability,
  type GithubEndpoint,
} from './permissions.js';
import type { GithubPermissions, GithubPlugin, GithubUser } from './schema.js';

/**
 * Hosts that github traffic legitimately reaches. The first four are auth /
 * git data hosts; `cli.github.com` is reached during the pre-lockdown
 * bootstrap to fetch the apt keyring and again when apt resolves the gh
 * package list. `*.githubusercontent.com` and `cli.github.com` are
 * intentionally excluded from per-repo authentication: paths there are
 * content hashes / package mirrors, not repo identifiers, so per-repo
 * scoping isn't meaningful. They stay in `domains` so requests aren't
 * blocked, but no token is attached.
 */
const GITHUB_DOMAINS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  '*.githubusercontent.com',
  'cli.github.com',
] as const;

/** Hosts that get policy-scoped credential injection (subset of GITHUB_DOMAINS). */
const GITHUB_AUTH_HOSTS: readonly GithubAuthHost[] = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
];

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
 * Default coarse matchers per host when a repo doesn't opt into
 * `permissions`. Preserves today's behaviour: token attaches to anything
 * under the repo path on the three auth hosts.
 */
const COARSE_PATH_PER_HOST: Record<GithubAuthHost, string> = {
  'github.com': '/{owner}/{repo}',
  'api.github.com': '/repos/{owner}/{repo}',
  'codeload.github.com': '/{owner}/{repo}',
};

/**
 * Expand a single github plugin into proxy domains, per-(host, repo)
 * policies that scope credential injection, a final per-host **block**
 * catch-all so requests outside the allowlisted repo paths fail fast at the
 * proxy with 403 (instead of leaking the placeholder to GitHub and getting
 * a confusing 401 back), and in-VM init commands that wire git credentials,
 * gh CLI auth, and the host machine's git identity.
 *
 * Each repo emits up to one policy per auth host. When the repo carries
 * `permissions`, matchers are derived from the capability map; when
 * `permissions` is omitted, matchers are omitted too and the policy is the
 * legacy coarse "anywhere under the repo path" rule. When `permissions: {}`
 * is given explicitly, no policies are emitted for that repo (host stays
 * allowlisted; requests pass through unauthenticated).
 *
 * After all per-repo allow policies, one catch-all `block` policy per auth
 * host is appended. Policy evaluation is first-match-wins, so the more
 * specific allows win over the broad block — but anything that doesn't
 * match an allow gets a clean 403 from the proxy with the policy id in the
 * body, instead of being silently passed through (and rejected by GitHub
 * with our placeholder still in the header). Hosts that are intentionally
 * pass-through (`*.githubusercontent.com`, `cli.github.com`) are NOT
 * blocked.
 *
 * Credentials are written to `~/.git-credentials` so other tools in the VM
 * (gh CLI, custom scripts) can read them, with a custom credential helper
 * installed by the bootstrap (see {@link GH_CLI_BOOTSTRAP_SCRIPT}) that
 * delegates `get` to git's own credential-store but no-ops on `store`/
 * `erase` — failed auth attempts therefore can't wipe the file.
 * `credential.useHttpPath = true` keeps per-repo path scoping. The
 * placeholder lands inside an `Authorization: Basic
 * <base64(username:placeholder)>` header for git, or a plaintext
 * `Authorization: token <placeholder>` header for the gh CLI; each policy
 * carries two `replace-header` mutations — one with a `base64` transform
 * for git, one without for gh — so both schemes substitute correctly at
 * request time.
 *
 * The `gh` CLI is pre-authenticated by writing `~/.config/gh/hosts.yml`
 * with the placeholder as `oauth_token`. Same proxy substitution rules
 * apply on the wire.
 *
 * If the plugin's optional `user` field is set, two additional commands
 * mirror its `name` / `email` into the VM's global git config so commits
 * use that identity. The field is part of `sandbox.json` (authoritative
 * and reproducible across machines); `aurica-sandbox init` pre-fills it
 * from the host's `~/.gitconfig` when available.
 *
 * The `~/.git-credentials` write truncates the file so re-running init is
 * idempotent. If a sandbox config ever has multiple github plugins, the
 * last-emitted plugin's command would clobber earlier ones — config
 * validation should reject that case (out of scope here).
 *
 * All policies for one plugin share `placeholder`, so the resolver only
 * needs to know which plugin the placeholder belongs to.
 */
export function expandGithub(
  plugin: GithubPlugin,
  placeholder: string,
): ExpandedPlugin {
  const policies: ProxyPolicy[] = [];
  const credentialUrls: string[] = [];

  const transform: ProxyPolicyTransform = {
    type: 'base64',
    prefix: `${plugin.username}:`,
  };

  for (const repo of plugin.repositories) {
    // Schema regex guarantees `<owner>/<repo>` shape, so split always yields
    // two non-empty strings.
    const [owner, name] = repo.name.split('/') as [string, string];

    if (repo.permissions === undefined) {
      // Legacy coarse policies — one per auth host, no matchers.
      for (const host of GITHUB_AUTH_HOSTS) {
        policies.push(
          coarsePolicyFor(
            repo.name,
            host,
            owner,
            name,
            placeholder,
            plugin.token,
            transform,
          ),
        );
      }
    } else {
      // Bucket capability endpoints by host; one policy per (repo, host).
      const buckets = bucketEndpointsByHost(repo.permissions);
      const capList = listCapabilities(repo.permissions);
      for (const host of GITHUB_AUTH_HOSTS) {
        const endpoints = buckets[host];
        if (endpoints.length === 0) continue;
        const matchers = endpoints.map((e) =>
          interpolateMatcher(e.matcher, owner, name),
        );
        policies.push({
          id: `github:${repo.name}:${host}`,
          description: `GitHub ${capList} for ${repo.name}`,
          domain: host,
          matchers,
          action: {
            type: 'allow',
            mutations: authMutations(placeholder, plugin.token, transform),
          },
        });
      }
    }

    credentialUrls.push(
      `https://${plugin.username}:${placeholder}@github.com/${repo.name}`,
    );
  }

  // Catch-all block per auth host. Appended after all allow policies so
  // first-match-wins preserves the allows. Anything that reaches a
  // catch-all gets a clean 403 from the proxy instead of leaking the
  // placeholder to GitHub.
  for (const host of GITHUB_AUTH_HOSTS) {
    policies.push({
      id: `github:block:${host}`,
      description: `Default-deny for ${host} — paths not in any repo's allowlist`,
      domain: host,
      action: { type: 'block' },
    });
  }

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
    ghHostsYamlCommand(plugin.username, placeholder),
    ...userIdentityCommands(plugin.user),
  ];

  return {
    domains: [...GITHUB_DOMAINS],
    policies,
    commands,
    bootstrapScript: GH_CLI_BOOTSTRAP_SCRIPT,
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
  token: string,
  transform: ProxyPolicyTransform,
): Mutation[] {
  return [
    {
      kind: 'replace-header',
      header: 'Authorization',
      from: placeholder,
      to: token,
      transform,
    },
    {
      kind: 'replace-header',
      header: 'Authorization',
      from: placeholder,
      to: token,
    },
  ];
}

/**
 * Pre-authenticate the gh CLI by writing `~/.config/gh/hosts.yml` with the
 * placeholder as `oauth_token`. Run as the default user so the file lands
 * in their home with correct ownership.
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
 * Mirror the plugin's configured `user.name` / `user.email` into the VM's
 * global git config so commits inside the sandbox carry the configured
 * identity. Returns an empty list when the plugin's `user` field is unset —
 * the field is optional, so missing means the user opted out of having
 * the sandbox manage their git identity.
 */
function userIdentityCommands(user: GithubUser | undefined): PluginCommand[] {
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

function coarsePolicyFor(
  repoName: string,
  host: GithubAuthHost,
  owner: string,
  name: string,
  placeholder: string,
  token: string,
  transform: ProxyPolicyTransform,
): ProxyPolicy {
  const prefix = COARSE_PATH_PER_HOST[host]
    .replaceAll('{owner}', owner)
    .replaceAll('{repo}', name);
  // Single matcher entry that's effectively the legacy `pathPrefix`
  // behaviour but with segment-boundary correctness baked in.
  const matchers: MatcherEntry[] = [{ prefix }];
  return {
    id: `github:${repoName}:${host}`,
    description: `GitHub credentials for ${repoName} (no permissions scoping)`,
    domain: host,
    matchers,
    action: {
      type: 'allow',
      mutations: authMutations(placeholder, token, transform),
    },
  };
}

function bucketEndpointsByHost(
  permissions: GithubPermissions,
): Record<GithubAuthHost, GithubEndpoint[]> {
  const buckets: Record<GithubAuthHost, GithubEndpoint[]> = {
    'github.com': [],
    'api.github.com': [],
    'codeload.github.com': [],
  };
  for (const [cap, level] of Object.entries(permissions) as [
    GithubCapability,
    'read' | 'write' | undefined,
  ][]) {
    if (!level) continue;
    for (const endpoint of GITHUB_CAPABILITY_MAP[cap][level]) {
      buckets[endpoint.host].push(endpoint);
    }
  }
  return buckets;
}

function listCapabilities(permissions: GithubPermissions): string {
  const parts: string[] = [];
  for (const [cap, level] of Object.entries(permissions) as [
    GithubCapability,
    'read' | 'write' | undefined,
  ][]) {
    if (level) parts.push(`${cap}:${level}`);
  }
  return parts.join(', ') || 'no capabilities';
}
