import type {
  MatcherEntry,
  Mutation,
  ProxyPolicy,
  ProxyPolicyTransform,
} from '#src/config/index.js';

import type { ExpandedPlugin, PluginCommand } from '../types.js';
import type { GithubPlugin, GithubUser } from './schema.js';

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

/** Auth hosts that get a per-host catch-all block policy when not allowed. */
type GithubAuthHost = 'github.com' | 'api.github.com' | 'codeload.github.com';
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
 * Expand a single github plugin into proxy domains, per-repo allow policies
 * for git smart-HTTP (one fetch matcher set per repo on `github.com` and
 * `codeload.github.com`, plus a push matcher unless `readOnly: true`), an
 * optional broad allow on `api.github.com` when plugin-level `api: true`, a
 * per-host catch-all `block` policy so requests outside the allowlist fail
 * fast at the proxy with 403 (instead of leaking the placeholder to GitHub),
 * and in-VM init commands that wire git credentials, gh CLI auth, and the
 * host machine's git identity.
 *
 * Per-repo capability filtering at the proxy was removed: the GitHub token
 * itself (fine-grained PAT or App installation token) is the source of
 * truth for which repos and which capabilities are reachable. Duplicating
 * that at the proxy added complexity and broke gh's GraphQL-backed
 * commands, which post to `/graphql` with the repo identity in the body
 * where path matchers can't see it. With `api: true` the `/graphql`
 * surface (and the rest of `api.github.com`) is opened wholesale; the
 * token is trusted to enforce per-repo scope on API traffic.
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
  const mutations = authMutations(placeholder, plugin.tokenSource, transform);

  for (const repo of plugin.repositories) {
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

    credentialUrls.push(
      `https://${plugin.username}:${placeholder}@github.com/${repo.name}`,
    );
  }

  if (plugin.api === true) {
    // Open all of api.github.com — GraphQL POSTs encode repo identity in
    // the body, so per-repo scoping at the proxy isn't meaningful for the
    // API surface. The configured token is trusted to enforce repo scope.
    policies.push({
      id: 'github:api:api.github.com',
      description: 'GitHub API access (token-scoped, including /graphql)',
      domain: 'api.github.com',
      action: { type: 'allow', mutations },
    });
  }

  // Catch-all block per auth host. Appended after all allow policies so
  // first-match-wins preserves the allows. Anything that reaches a
  // catch-all gets a clean 403 from the proxy instead of leaking the
  // placeholder to GitHub. The api.github.com block is shadowed by the
  // broad allow above when `api: true`, but is still emitted for symmetry.
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
 * Allow policy for git smart-HTTP on `github.com` covering fetch
 * (`info/refs` GET + `git-upload-pack` POST). Push (`git-receive-pack`
 * POST) is added unless `readOnly` is set.
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
    { exact: `/${owner}/${name}/git-upload-pack`, methods: ['POST'] },
  ];
  if (!readOnly) {
    matchers.push({
      exact: `/${owner}/${name}/git-receive-pack`,
      methods: ['POST'],
    });
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
