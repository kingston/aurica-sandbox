import type { ProxyPolicy } from '#src/config/index.js';

import type { SandboxPlugin } from '../types.js';
import { cursorProjectConfigSchema } from './schema.js';

/**
 * Cache the Cursor REH tarball host-globally across sandboxes. The download
 * URL is content-addressed (a 40-hex commit hash in the path under
 * `/production/`), so the bytes are immutable, public, and unauthenticated —
 * safe to serve from a shared cache. The in-VM pre-warm and the user's first
 * remote-SSH connect both go through the proxy, so the first sandbox populates
 * the cache and every later one serves the ~80 MB tarball from disk.
 */
const CURSOR_REH_CACHE_POLICY: ProxyPolicy = {
  id: 'cursor:reh-download-cache',
  description:
    'Cache the content-addressed Cursor REH tarball across sandboxes',
  domain: 'downloads.cursor.com',
  matchers: [{ prefix: '/production/', methods: ['GET'] }],
  action: { type: 'allow', cacheResponse: { ttlSeconds: 7 * 24 * 60 * 60 } },
};

/**
 * Hosts Cursor remote-SSH reaches from inside the VM. `downloads.cursor.com`
 * serves the per-commit REH tarball; `api*.cursor.sh` / `repo42.cursor.sh`
 * are the Cursor backend the REH calls at runtime; the marketplace + VS Code
 * fallback hosts cover extension installs from inside the remote window.
 * `marketplace.cursorapi.com` resolves the extension manifest, then 302s the
 * asset fetch to `cursor-cdn.com` (content-addressed `/openvsx_v0/...` hashes),
 * so both are needed to install extensions like the GitHub PR extension.
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
  'cursor-cdn.com',
  'update.code.visualstudio.com',
  'vscode.download.prss.microsoft.com',
] as const;

/**
 * Cursor plugin. Contributes the Cursor remote-SSH domain allowlist plus a
 * response-cache policy for the REH tarball, so the first sandbox to connect
 * populates the host-global cache and every later one serves the ~80 MB
 * download from disk. The user's first remote-SSH connect fetches the REH
 * server on demand through the proxy (cached after the first download).
 */
export const cursorPlugin: SandboxPlugin<
  undefined,
  typeof cursorProjectConfigSchema
> = {
  name: 'cursor',
  projectConfigSchema: cursorProjectConfigSchema,
  userConfigSchema: undefined,
  initialize() {
    return {
      domains: [...CURSOR_DOMAINS],
      policies: [CURSOR_REH_CACHE_POLICY],
      commands: [],
    };
  },
};
