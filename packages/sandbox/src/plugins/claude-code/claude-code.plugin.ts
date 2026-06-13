import { input, select } from '@inquirer/prompts';

import type { ProxyPolicy } from '#src/config/proxy-policy.js';
import { defaultCredentialStore } from '#src/credentials/credential-store.js';
import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

import type { PluginCommand, SandboxPlugin } from '../types.js';
import { registerClaudeCommands } from './cli/claude-commands.js';
import { claudeRecord } from './oauth.js';
import {
  type ClaudeCodeProjectConfig,
  claudeCodeProjectConfigSchema,
} from './schema.js';

/**
 * Hosts Claude Code reaches in `api-key` / `oauth-token` modes — installer
 * entry point and release artifact bucket. The `claude.ai` bootstrap URL
 * 302s to `downloads.claude.ai`.
 *
 * `api.anthropic.com` is covered by the `claude-code:api` allow policy and
 * doesn't need to appear here. `subscription` mode adds `claude.ai` again
 * (harmless dedup) via {@link CLAUDE_SUBSCRIPTION_OAUTH_DOMAINS}.
 *
 * Telemetry hosts (`statsig.anthropic.com`, `*.sentry.io`) are deliberately
 * omitted; `DISABLE_TELEMETRY=1` in `settings.json.env` keeps Claude Code
 * from reaching for them.
 */
const CLAUDE_CODE_DOMAINS = ['claude.ai', 'downloads.claude.ai'] as const;

/**
 * Hosts the guest's `claude /login` flow touches end-to-end. Allowed only
 * for `subscription` mode. `platform.claude.com` is covered by the
 * `claude-code:oauth-token` allow policy.
 */
const CLAUDE_SUBSCRIPTION_OAUTH_DOMAINS = ['claude.ai'] as const;

/**
 * Record key whose secrets the proxy interceptor writes into when it
 * captures a token-grant response. Must match {@link claudeRecord}'s key
 * — kept in sync at compile time via this import.
 */
const CLAUDE_RECORD_KEY = claudeRecord.key;

/**
 * Per-`authMode` knobs:
 *
 * - `keepHeader`    — the header Claude Code's auth value should land in for
 *                     this mode. The proxy substitutes the placeholder there.
 * - `dropHeader`    — the *other* header. `apiKeyHelper`'s output is sent in
 *                     BOTH `X-Api-Key` and `Authorization: Bearer`
 *                     simultaneously (per the apiKeyHelper docs at
 *                     https://code.claude.com/docs/en/settings), so the proxy
 *                     must strip the wrong one before forwarding — Anthropic
 *                     would otherwise see two conflicting auth headers and
 *                     pick the wrong shape (e.g. an OAuth token sent under
 *                     X-Api-Key and rejected as malformed).
 * - `defaultSource` — credential-source string the proxy resolves when the
 *                     user hasn't set `tokenSource` explicitly. For `env:`
 *                     modes this is just `env:<VAR>`; for `subscription`
 *                     it's `vault:<claude-record-key>`, which the
 *                     `vault` credential provider resolves to whatever the
 *                     proxy's `oauth-token-response` interceptor most
 *                     recently persisted under that key.
 */
const AUTH_MODE: Record<
  ClaudeCodeProjectConfig['authMode'],
  { keepHeader: string; dropHeader: string; defaultSource: string }
> = {
  'api-key': {
    keepHeader: 'x-api-key',
    dropHeader: 'Authorization',
    defaultSource: 'env:ANTHROPIC_API_KEY',
  },
  'oauth-token': {
    keepHeader: 'Authorization',
    dropHeader: 'x-api-key',
    defaultSource: 'env:CLAUDE_CODE_OAUTH_TOKEN',
  },
  subscription: {
    keepHeader: 'Authorization',
    dropHeader: 'x-api-key',
    defaultSource: `vault:${CLAUDE_RECORD_KEY}#accessToken`,
  },
};

/**
 * Build the pre-lockdown shell snippet that installs Claude Code into
 * `<user>`'s `~/.local/bin` via the official bootstrap. `sudo -iu` gives a
 * login shell so the installer's PATH and HOME are the user's, not root's.
 *
 * `user` is interpolated directly — caller has already validated it via
 * {@link assertSafeShellIdent}.
 */
function claudeCodeBootstrapScript(user: string): string {
  return `# claude-code plugin: install Claude Code into <user>'s ~/.local/bin via the
# official bootstrap. Mirrors the mise plugin's install pattern.
sudo -iu ${user} bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'`;
}

/**
 * Claude Code plugin. Contributes:
 *
 * 1. Proxy domains for the installer + inference API; `subscription` mode
 *    additionally allowlists the OAuth-flow hosts.
 * 2. An allow policy on `api.anthropic.com` whose mutations substitute the
 *    placeholder for the resolved credential in the mode-appropriate header
 *    and drop the *other* header. (Without the drop step, `apiKeyHelper`'s
 *    output would land in both headers and Anthropic would reject the
 *    mismatched pair.)
 * 3. For `subscription` mode only: an allow policy on
 *    `platform.claude.com/v1/oauth/token` with an `oauth-token-response`
 *    response interceptor. The proxy captures the real tokens off the wire,
 *    persists them to the host slot, and rewrites the response with
 *    per-sandbox placeholders before forwarding to the guest.
 * 4. A bootstrap snippet that runs the official installer pre-lockdown.
 * 5. Post-lockdown commands. For `api-key` / `oauth-token`: writes
 *    `~/.claude/settings.json` with `apiKeyHelper: "/bin/echo
 *    <placeholder>"` so Claude Code emits the placeholder on every request.
 *    For `subscription`: pre-seeds `~/.claude/.credentials.json` with the
 *    same placeholder pair the proxy interceptor will rewrite real tokens
 *    onto, plus `subscriptionType: "max"`, so a returning sandbox boots
 *    pre-authenticated when the host slot already exists.
 *
 * `DISABLE_AUTOUPDATER` and `DISABLE_TELEMETRY` are set in the settings
 * file so background traffic stays inside the allowlist.
 */
export const claudeCodePlugin: SandboxPlugin<
  undefined,
  typeof claudeCodeProjectConfigSchema
> = {
  name: 'claude-code',
  description: 'Run Claude Code with host-injected credentials',
  projectConfigSchema: claudeCodeProjectConfigSchema,
  userConfigSchema: undefined,
  async promptProjectConfig(): Promise<ClaudeCodeProjectConfig> {
    const authMode = await select<ClaudeCodeProjectConfig['authMode']>({
      message: 'Claude Code authentication mode',
      choices: [
        {
          name: 'subscription (Pro/Max/Team — login via `claude /login`)',
          value: 'subscription',
        },
        {
          name: 'oauth-token (long-lived token from `claude setup-token`)',
          value: 'oauth-token',
        },
        { name: 'api-key (ANTHROPIC_API_KEY)', value: 'api-key' },
      ],
    });
    const tokenAnswer = await input({
      message: 'Custom token source (leave blank for the mode default)',
    });
    const tokenSource = tokenAnswer.trim();
    return { authMode, ...(tokenSource ? { tokenSource } : {}) };
  },
  cliCommands(program): void {
    registerClaudeCommands(program);
  },
  async initialize({ project, generatePlaceholder, linuxUser }) {
    assertSafeShellIdent('linuxUser', linuxUser);

    const { keepHeader, dropHeader, defaultSource } =
      AUTH_MODE[project.authMode];
    const tokenSource = project.tokenSource ?? defaultSource;

    // Subscription mode rides on two placeholders that the proxy's
    // `oauth-token-response` policy rewrites into the guest-visible
    // `~/.claude/.credentials.json`:
    //
    //   - `subscriptionAccessToken` — unversioned. Stays the same string
    //     across the sandbox's lifetime. The proxy's `replace-header`
    //     mutation substring-matches it on `Authorization: Bearer
    //     <accessPlaceholder>` and substitutes the real access token from
    //     the slot. Static so the policy doesn't need a reload on every
    //     refresh.
    //
    //   - `subscriptionRefreshTokenBase` — the BASE of the versioned
    //     refresh placeholder. The synthesized token Claude Code holds is
    //     `${subscriptionRefreshTokenBase}:${currentCounter}`; the proxy
    //     extracts the trailing `:<n>` from inbound refresh requests to
    //     drive the refresh-race short-circuit. The base is baked into
    //     the policy because that's what the response interceptor and
    //     refresh short-circuit need to know to mint the next versioned
    //     placeholder.
    //
    // The `oauth-token` / `api-key` modes don't have an interceptor; they
    // use a regular `__AURICA_TOKEN_XXX__` placeholder emitted via
    // `apiKeyHelper` instead.
    const accessPlaceholder = generatePlaceholder('access');
    const refreshPlaceholder = generatePlaceholder('refresh');
    const subscriptionAccessToken = `sk-ant-oat01-aurica-${accessPlaceholder}`;
    const subscriptionRefreshTokenBase = `sk-ant-ort01-aurica-${refreshPlaceholder}`;

    const apiPlaceholder =
      project.authMode === 'subscription'
        ? subscriptionAccessToken
        : generatePlaceholder('api');

    const policies: ProxyPolicy[] = [
      {
        id: 'claude-code:api',
        description: `Inject Claude Code ${project.authMode} credential into ${keepHeader} and strip ${dropHeader}`,
        domain: 'api.anthropic.com',
        action: {
          type: 'allow',
          mutations: [
            {
              kind: 'replace-header',
              header: keepHeader,
              from: apiPlaceholder,
              to: tokenSource,
            },
            {
              kind: 'remove-header',
              header: dropHeader,
            },
          ],
        },
      },
    ];

    const commands: PluginCommand[] = [];
    const domains: string[] = [...CLAUDE_CODE_DOMAINS];

    if (project.authMode === 'subscription') {
      domains.push(...CLAUDE_SUBSCRIPTION_OAUTH_DOMAINS);

      policies.push({
        id: 'claude-code:oauth-token',
        description:
          'Claude OAuth token endpoint. authorization_code grants are forwarded upstream; the response interceptor persists newly-issued tokens to the slot and rewrites the body with per-sandbox placeholders before forwarding to the guest. refresh_token grants are short-circuited on the host (mutex-guarded) so parallel 401-triggered refreshes from the guest do not race the upstream refresh-token rotation.',
        domain: 'platform.claude.com',
        matchers: [{ exact: '/v1/oauth/token', methods: ['POST'] }],
        action: {
          type: 'allow',
          interceptResponse: {
            kind: 'oauth-token-response',
            recordKey: CLAUDE_RECORD_KEY,
            placeholders: {
              accessToken: subscriptionAccessToken,
              refreshToken: subscriptionRefreshTokenBase,
            },
          },
        },
      });

      commands.push(
        settingsJsonCommand({ apiKeyHelper: null }),
        claudeJsonCommand(),
      );
      // Only seed `~/.claude/.credentials.json` when we have real
      // metadata from a prior login on this host. Without a slot, the
      // scopes / `subscriptionType` we'd write are guesses — better to
      // let Claude Code on the guest show its native "not logged in"
      // state, run `claude /login`, and let the interceptor populate
      // the slot for the next sandbox.
      const cachedSlot = await defaultCredentialStore.read(claudeRecord);
      if (cachedSlot !== undefined) {
        // Embed the slot's current counter into the refresh placeholder
        // so the guest's first refresh attempt matches the host's view —
        // the proxy compares `:<n>` to `currentCounter` and would 400
        // anything ahead of it.
        const versionedRefreshToken = `${subscriptionRefreshTokenBase}:${cachedSlot.currentCounter}`;
        const cachedSubscriptionType =
          typeof cachedSlot.extras.subscriptionType === 'string'
            ? cachedSlot.extras.subscriptionType
            : 'max';
        commands.push(
          credentialsJsonCommand({
            accessToken: subscriptionAccessToken,
            refreshToken: versionedRefreshToken,
            scopes: cachedSlot.scopes,
            subscriptionType: cachedSubscriptionType,
          }),
        );
      }
    } else {
      commands.push(
        settingsJsonCommand({ apiKeyHelper: apiPlaceholder }),
        claudeJsonCommand(),
      );
    }

    return {
      domains,
      policies,
      commands,
      bootstrapScript: claudeCodeBootstrapScript(linuxUser),
    };
  },
};

/**
 * Pre-seed `~/.claude.json` so Claude Code's first launch skips the theme
 * picker, the onboarding wizard, and the per-project "Do you trust the
 * files in this folder?" prompt.
 *
 * Three keys do the work, all observed in a running Claude Code 2.x state
 * file:
 *
 * - `hasCompletedOnboarding: true` — top-level flag the binary checks to
 *   bypass the welcome flow.
 * - `theme: "auto"` — top-level theme preference; `auto` detects the
 *   terminal background and follows light/dark accordingly.
 * - `projects.<absolute-path>.hasTrustDialogAccepted: true` — per-project
 *   trust flag keyed by the **exact** absolute cwd Claude Code is launched
 *   from. There is no global `trustedFolders` setting; the binary keys
 *   trust by the project path.
 *
 * The trust path is sourced from `AURICA_PROJECT_DIR` in
 * `/etc/environment` (written by the github plugin earlier in the command
 * list). When that variable isn't set — e.g. no github plugin configured,
 * or `/etc/environment` missing — we still write the theme and onboarding
 * flags and just skip the `projects.*` entry; the next `claude` invocation
 * will prompt for trust once and persist the answer itself.
 *
 * The file is opened with `umask 077` and `mode 600` because it carries
 * OAuth session state on real installs; we match that posture here so a
 * later `claude /login` doesn't downgrade the perms.
 */
function claudeJsonCommand(): PluginCommand {
  const script = String.raw`
set -eu
project_dir=""
if [ -r /etc/environment ]; then
  # sed instead of source: avoid executing arbitrary content in /etc/environment
  project_dir=$(sed -n 's/^AURICA_PROJECT_DIR=//p' /etc/environment | tail -n1)
fi
umask 077
python3 - "$project_dir" <<'PY' > "$HOME/.claude.json"
import json, sys
project_dir = sys.argv[1]
state = {
    "hasCompletedOnboarding": True,
    "theme": "auto",
}
if project_dir:
    state["projects"] = {
        project_dir: {
            "hasTrustDialogAccepted": True,
            "allowedTools": [],
            "mcpServers": {},
            "enabledMcpjsonServers": [],
            "disabledMcpjsonServers": [],
            "enableAllProjectMcpServers": False,
            "ignorePatterns": [],
            "dontCrawlDirectory": False,
            "mcpContextUris": [],
        }
    }
json.dump(state, sys.stdout, indent=2)
PY
chmod 600 "$HOME/.claude.json"
`;
  return {
    user: 'default',
    argv: ['sh', '-c', script],
  };
}

/**
 * Write `~/.claude/settings.json`. `apiKeyHelper` is set to
 * `/bin/echo <placeholder>` for `api-key` / `oauth-token` modes — Claude
 * Code reads this file unconditionally on startup and on every credential
 * refresh, so the placeholder propagates cleanly to both interactive and
 * non-interactive invocations.
 *
 * For `subscription` mode, `apiKeyHelper` is omitted: Claude Code is
 * driven by `~/.claude/.credentials.json` instead, and an `apiKeyHelper`
 * would shadow it (the helper's output wins over the file-based token).
 *
 * `DISABLE_AUTOUPDATER` blocks the in-process update check (which would
 * try `downloads.claude.ai` periodically). `DISABLE_TELEMETRY` keeps
 * Claude Code from reaching for `statsig.anthropic.com` / Sentry, neither
 * of which is in the proxy allowlist.
 */
function settingsJsonCommand(opts: {
  apiKeyHelper: string | null;
}): PluginCommand {
  const settings: Record<string, unknown> = {
    env: {
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    },
  };
  if (opts.apiKeyHelper !== null) {
    settings.apiKeyHelper = `/bin/echo ${opts.apiKeyHelper}`;
  }
  const body = JSON.stringify(settings, null, 2);
  return {
    user: 'default',
    argv: [
      'sh',
      '-c',
      String.raw`mkdir -p "$HOME/.claude" && umask 077 && printf "%s\n" "$@" > "$HOME/.claude/settings.json"`,
      'sh',
      body,
    ],
  };
}

/**
 * Pre-seed `~/.claude/.credentials.json` with the placeholder access /
 * refresh tokens, plus the real `scopes` and `subscriptionType` captured
 * from the most recent host-side OAuth slot. Claude Code reads this file
 * on Linux when no `apiKeyHelper` is configured and treats it as a
 * subscription-tier session.
 *
 * Shape mirrors what Claude Code itself writes after a successful
 * `/login`:
 *
 * ```
 * {
 *   "claudeAiOauth": {
 *     "accessToken": "sk-ant-oat01-...",
 *     "refreshToken": "sk-ant-ort01-...",
 *     "expiresAt": 1893456000000,
 *     "scopes": ["user:inference", ...],
 *     "subscriptionType": "max"
 *   }
 * }
 * ```
 *
 * Only emitted when the host slot is already populated — see the
 * caller in {@link claudeCodePlugin}'s `initialize`. With a fresh
 * machine, `~/.claude/.credentials.json` is left unwritten so the
 * guest's `claude /login` is the source of truth for `scopes` /
 * `subscriptionType`.
 */
function credentialsJsonCommand(opts: {
  accessToken: string;
  refreshToken: string;
  scopes: readonly string[];
  subscriptionType: string;
}): PluginCommand {
  const credentials = {
    claudeAiOauth: {
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      scopes: [...opts.scopes],
      subscriptionType: opts.subscriptionType,
    },
  };
  const body = JSON.stringify(credentials, null, 2);
  return {
    user: 'default',
    argv: [
      'sh',
      '-c',
      String.raw`mkdir -p "$HOME/.claude" && umask 077 && printf "%s\n" "$@" > "$HOME/.claude/.credentials.json" && chmod 600 "$HOME/.claude/.credentials.json"`,
      'sh',
      body,
    ],
  };
}
