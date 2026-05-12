import type { ProxyPolicy } from '#src/config/proxy-policy.js';
import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

import type { PluginCommand, SandboxPlugin } from '../types.js';
import {
  type ClaudeCodeProjectConfig,
  claudeCodeProjectConfigSchema,
} from './schema.js';

/**
 * Hosts Claude Code reaches once installed. The first two are the official
 * installer entry point + release artifact bucket (the `claude.ai`
 * bootstrap URL 302s to `downloads.claude.ai`); the third is the inference
 * API where credential injection happens.
 *
 * Auth-flow hosts (`console.anthropic.com`, `claude.ai/oauth/*`) are
 * intentionally NOT in the list — the sandbox must not be able to start its
 * own `/login`. Auth always happens on the host (today via env-var
 * `tokenSource`; in the future via a `claude-oauth` credential provider).
 *
 * Telemetry hosts (`statsig.anthropic.com`, `*.sentry.io`) are also
 * omitted; `DISABLE_TELEMETRY=1` in `settings.json.env` keeps Claude Code
 * from reaching for them.
 */
const CLAUDE_CODE_DOMAINS = [
  'claude.ai',
  'downloads.claude.ai',
  'api.anthropic.com',
] as const;

/**
 * Per-`authMode` knobs:
 *
 * - `keepHeader`   — the header Claude Code's auth value should land in for
 *                    this mode. The proxy substitutes the placeholder there.
 * - `dropHeader`   — the *other* header. `apiKeyHelper`'s output is sent in
 *                    BOTH `X-Api-Key` and `Authorization: Bearer`
 *                    simultaneously (per the apiKeyHelper docs at
 *                    https://code.claude.com/docs/en/settings), so the proxy
 *                    must strip the wrong one before forwarding — Anthropic
 *                    would otherwise see two conflicting auth headers and
 *                    pick the wrong shape (e.g. an OAuth token sent under
 *                    X-Api-Key and rejected as malformed).
 * - `defaultEnv`   — env var name the default `tokenSource` resolves from
 *                    when `tokenSource` isn't set explicitly.
 */
const AUTH_MODE: Record<
  ClaudeCodeProjectConfig['authMode'],
  { keepHeader: string; dropHeader: string; defaultEnv: string }
> = {
  'api-key': {
    keepHeader: 'x-api-key',
    dropHeader: 'Authorization',
    defaultEnv: 'ANTHROPIC_API_KEY',
  },
  'oauth-token': {
    keepHeader: 'Authorization',
    dropHeader: 'x-api-key',
    defaultEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
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
 * 1. Proxy domains for the installer + inference API.
 * 2. A single allow policy on `api.anthropic.com` whose mutations
 *    (a) substitute the placeholder for the resolved credential in the
 *    mode-appropriate header (`X-Api-Key` for api-key, `Authorization` for
 *    oauth-token), and (b) drop the *other* header. `apiKeyHelper`'s
 *    output is sent in both `X-Api-Key` and `Authorization: Bearer`
 *    simultaneously (per the settings docs), so without the drop step
 *    Anthropic would see two conflicting auth headers — e.g. an OAuth
 *    token under `X-Api-Key` would be rejected as malformed. Substring
 *    replacement matches just the placeholder, leaving the `Bearer `
 *    prefix on `Authorization` intact.
 * 3. A bootstrap snippet that runs the official installer pre-lockdown.
 * 4. A post-lockdown command that writes `~/.claude/settings.json` with
 *    `apiKeyHelper: "/bin/echo <placeholder>"`. Claude Code runs that
 *    helper on every request, gets the placeholder back as the token, and
 *    sends it on the wire — where the proxy mutations above swap it for
 *    the real credential and strip the wrong header. This mirrors Docker
 *    Sandbox's `apiKeyHelper: "echo proxy-managed"` pattern but uses
 *    aurica's deterministic per-plugin placeholder so multiple plugins
 *    targeting the same host can't collide on resolution.
 *
 * `DISABLE_AUTOUPDATER` and `DISABLE_TELEMETRY` are set in the same
 * settings file so background traffic stays inside the allowlist (no
 * surprise hits to update or telemetry hosts). Auto-updates would also
 * fail under the iptables lockdown if attempted post-init.
 */
export const claudeCodePlugin: SandboxPlugin<
  undefined,
  typeof claudeCodeProjectConfigSchema
> = {
  name: 'claude-code',
  projectConfigSchema: claudeCodeProjectConfigSchema,
  userConfigSchema: undefined,
  initialize({ project, placeholder, linuxUser }) {
    assertSafeShellIdent('linuxUser', linuxUser);

    const { keepHeader, dropHeader, defaultEnv } = AUTH_MODE[project.authMode];
    const tokenSource = project.tokenSource ?? `env:${defaultEnv}`;

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
              // Substring match — the placeholder appears verbatim in the
              // header value (Claude Code's apiKeyHelper emits it as-is).
              // For `Authorization: Bearer <placeholder>`, replacing just
              // `<placeholder>` leaves the `Bearer ` prefix untouched.
              from: placeholder,
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

    return {
      domains: [...CLAUDE_CODE_DOMAINS],
      policies,
      commands: [settingsJsonCommand(placeholder), claudeJsonCommand()],
      bootstrapScript: claudeCodeBootstrapScript(linuxUser),
    };
  },
};

/**
 * Write `~/.claude/settings.json` as the default user with `apiKeyHelper`
 * pointing at `/bin/echo <placeholder>`. Claude Code reads this file
 * unconditionally on startup and on every credential refresh (5-minute TTL
 * by default, plus on HTTP 401), so the placeholder propagates cleanly to
 * both interactive and non-interactive invocations — unlike `/etc/environment`,
 * which only works for login shells.
 *
 * `DISABLE_AUTOUPDATER` blocks the in-process update check (which would
 * try `downloads.claude.ai` periodically). `DISABLE_TELEMETRY` keeps
 * Claude Code from reaching for `statsig.anthropic.com` / Sentry, neither
 * of which is in the proxy allowlist.
 *
 * The body is passed through `printf "%s\n" "$@"` so the placeholder is
 * never interpolated by the wrapping shell. `umask 077` keeps perms tight
 * on the credential-bearing file. Truncating on each init keeps re-runs
 * idempotent.
 */
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
  // Embedded Python keeps JSON-escaping correct for paths containing
  // characters that would otherwise need shell quoting (quotes,
  // backslashes, spaces). `python3` is preinstalled on Ubuntu/Debian, the
  // two distros the sandbox supports.
  const script = String.raw`
set -eu
project_dir=""
if [ -r /etc/environment ]; then
  # Sourcing /etc/environment would execute it; read the value directly so
  # a malformed line cannot run code.
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

function settingsJsonCommand(placeholder: string): {
  user: 'default';
  argv: string[];
} {
  const body = JSON.stringify(
    {
      apiKeyHelper: `/bin/echo ${placeholder}`,
      env: {
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
      },
    },
    null,
    2,
  );
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
