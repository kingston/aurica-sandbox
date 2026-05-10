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
import type { GithubPermissions, GithubPlugin } from './schema.js';

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
 * policies that scope credential injection, and in-VM init commands that
 * wire git credentials.
 *
 * Each repo emits up to one policy per auth host. When the repo carries
 * `permissions`, matchers are derived from the capability map; when
 * `permissions` is omitted, matchers are omitted too and the policy is the
 * legacy coarse "anywhere under the repo path" rule. When `permissions: {}`
 * is given explicitly, no policies are emitted for that repo (host stays
 * allowlisted; requests pass through unauthenticated).
 *
 * Credentials are written to `~/.git-credentials` so other tools in the VM
 * (gh CLI, custom scripts) can read them, with a custom credential helper
 * installed by the bootstrap (see {@link GH_CLI_BOOTSTRAP_SCRIPT}) that
 * delegates `get` to git's own credential-store but no-ops on `store`/
 * `erase` — failed auth attempts therefore can't wipe the file.
 * `credential.useHttpPath = true` keeps per-repo path scoping. The
 * placeholder lands inside an `Authorization: Basic
 * <base64(username:placeholder)>` header on the wire; the policy's
 * `replace-header` mutation uses a `base64` transform with the same
 * `username:` prefix so it can match the encoded blob and substitute
 * `base64(username:realToken)` at request time.
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
            mutations: [authMutation(placeholder, plugin.token, transform)],
          },
        });
      }
    }

    credentialUrls.push(
      `https://${plugin.username}:${placeholder}@github.com/${repo.name}`,
    );
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
  ];

  return {
    domains: [...GITHUB_DOMAINS],
    policies,
    commands,
    bootstrapScript: GH_CLI_BOOTSTRAP_SCRIPT,
  };
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
      mutations: [authMutation(placeholder, token, transform)],
    },
  };
}

function authMutation(
  placeholder: string,
  token: string,
  transform: ProxyPolicyTransform,
): Mutation {
  return {
    kind: 'replace-header',
    header: 'Authorization',
    from: placeholder,
    to: token,
    transform,
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
