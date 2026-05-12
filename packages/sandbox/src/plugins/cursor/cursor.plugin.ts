import type { PluginCommand, SandboxPlugin } from '../types.js';
import * as hostCursor from './host-cursor.js';
import type { HostCursor } from './host-cursor.js';
import { cursorProjectConfigSchema } from './schema.js';

/**
 * Hosts Cursor remote-SSH reaches from inside the VM. `downloads.cursor.com`
 * serves the per-commit REH tarball; `api*.cursor.sh` / `repo42.cursor.sh`
 * are the Cursor backend the REH calls at runtime; the marketplace + VS Code
 * fallback hosts cover extension installs from inside the remote window.
 *
 * Deliberately omitted: `mobile.events.data.microsoft.com` and
 * `default.exp-tas.com`. Those carry telemetry/experiments and are expected
 * to stay blocked — the 403s in the proxy log for those hosts are working
 * as intended.
 */
const CURSOR_DOMAINS = [
  'downloads.cursor.com',
  'api2.cursor.sh',
  'api3.cursor.sh',
  'repo42.cursor.sh',
  'marketplace.cursorapi.com',
  'update.code.visualstudio.com',
  'vscode.download.prss.microsoft.com',
] as const;

/**
 * Build the post-lockdown command that pre-warms
 * `~/.cursor-server/bin/<commit>/` with the matching REH tarball so the
 * user's first remote-SSH connect skips the ~80 MB download.
 *
 * Runs as the default user (the REH server lives in the user's home, not
 * a root-owned location) and goes through the proxy — `downloads.cursor.com`
 * is in the plugin's domain allowlist, and the VM's CA bundle already
 * trusts the proxy. The download is skipped when the per-commit cache dir
 * is already populated, so re-running init on an existing VM is cheap.
 *
 * `commit` and `arch` flow in as positional args (`$1`, `$2`), so the
 * shell snippet never interpolates either value into its body. `commit`
 * is strictly validated as 40 hex chars and `arch` is a closed enum, so
 * neither is attacker-controlled in any case.
 */
function cursorRehPrewarmCommand(host: HostCursor): PluginCommand {
  return {
    user: 'default',
    argv: [
      'sh',
      '-c',
      [
        'set -eu',
        'commit="$1"',
        'arch="$2"',
        'dest="$HOME/.cursor-server/bin/$commit"',
        // Skip when the binary's already there — re-init is idempotent.
        'if [ -x "$dest/bin/cursor-server" ]; then exit 0; fi',
        'mkdir -p "$dest"',
        'tmp=$(mktemp -d)',
        'trap \'rm -rf "$tmp"\' EXIT',
        'curl -fsSL "https://downloads.cursor.com/production/$commit/linux/$arch/cursor-reh-linux-$arch.tar.gz" -o "$tmp/reh.tar.gz"',
        'tar -xzf "$tmp/reh.tar.gz" -C "$dest" --strip-components=1',
      ].join(' && '),
      'sh',
      host.commit,
      host.arch,
    ],
  };
}

/**
 * Cursor plugin. Always contributes the Cursor remote-SSH domain
 * allowlist. When a host `Cursor.app` is detectable at sandbox-create
 * time, additionally emits a post-lockdown command that pre-warms the
 * matching REH server inside the VM (running as the default user, via
 * the proxy).
 *
 * Detection failure (no Cursor installed, unsupported host arch, etc.)
 * is not an error — remote-SSH still works on first connect via the
 * `downloads.cursor.com` allowlist; pre-warm is a latency optimization.
 */
export const cursorPlugin: SandboxPlugin<
  undefined,
  typeof cursorProjectConfigSchema
> = {
  name: 'cursor',
  projectConfigSchema: cursorProjectConfigSchema,
  userConfigSchema: undefined,
  initialize() {
    const host = hostCursor.readHostCursor();
    return {
      domains: [...CURSOR_DOMAINS],
      policies: [],
      commands: host ? [cursorRehPrewarmCommand(host)] : [],
    };
  },
};
