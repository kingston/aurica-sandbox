import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

import type { SandboxPlugin } from '../types.js';
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
 * Build the pre-lockdown shell snippet that pre-warms
 * `~/.cursor-server/bin/<commit>/` with the matching REH tarball so the
 * user's first remote-SSH connect skips the ~80 MB download. Skipped when
 * the directory is already populated, so re-running init on an existing VM
 * is cheap.
 *
 * `user` is interpolated directly — caller has already validated it via
 * {@link assertSafeShellIdent}. `commit` and `arch` come from
 * {@link readHostCursor}: `commit` is strictly validated as 40 hex chars and
 * `arch` is a closed enum, so neither needs additional shell-safety guards.
 */
function cursorBootstrapScript(user: string, host: HostCursor): string {
  return `# cursor plugin: pre-warm the Cursor remote-extension-host server so
# the user's first remote-SSH connect skips the ~80 MB tarball download.
# Best-effort — a failed download leaves the cache absent and Cursor will
# fall back to fetching on connect.
sudo -iu ${user} bash -ls <<'CURSOR_REH_EOF'
set -euo pipefail
commit="${host.commit}"
arch="${host.arch}"
dest="$HOME/.cursor-server/bin/$commit"
if [ ! -x "$dest/bin/cursor-server" ]; then
  mkdir -p "$dest"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://downloads.cursor.com/production/$commit/linux/$arch/cursor-reh-linux-$arch.tar.gz" \\
    -o "$tmp/reh.tar.gz"
  tar -xzf "$tmp/reh.tar.gz" -C "$dest" --strip-components=1
fi
CURSOR_REH_EOF`;
}

/**
 * Cursor plugin. Always contributes the Cursor remote-SSH domain allowlist.
 * When a host `Cursor.app` is detectable at sandbox-create time,
 * additionally emits a bootstrap snippet that pre-warms the matching REH
 * server inside the VM.
 *
 * Detection failure (no Cursor installed, unsupported host arch, etc.) is
 * not an error — remote-SSH still works on first connect via the
 * `downloads.cursor.com` allowlist; pre-warm is a latency optimization.
 */
export const cursorPlugin: SandboxPlugin<
  undefined,
  typeof cursorProjectConfigSchema
> = {
  name: 'cursor',
  projectConfigSchema: cursorProjectConfigSchema,
  userConfigSchema: undefined,
  initialize({ linuxUser }) {
    assertSafeShellIdent('linuxUser', linuxUser);
    const host = hostCursor.readHostCursor();
    return {
      domains: [...CURSOR_DOMAINS],
      policies: [],
      commands: [],
      ...(host
        ? { bootstrapScript: cursorBootstrapScript(linuxUser, host) }
        : {}),
    };
  },
};
