import { execa } from 'execa';

import type { CredentialProvider } from '../types.js';

const IDLE_TIMEOUT_MS = 900_000;

let cachedToken: string | undefined;
let lastUsedAt = 0;

/**
 * Resolves credentials of the form `gh-token` by running `gh auth token` on
 * the host and returning trimmed stdout. Memoizes the result for up to 15
 * minutes of inactivity to avoid repeated subprocess spawns on the hot proxy
 * path — each hit refreshes the idle timer so an active session never expires.
 */
export const ghTokenCredentialProvider: CredentialProvider = {
  scheme: 'gh-token',
  async resolve(): Promise<string> {
    const now = Date.now();
    if (cachedToken !== undefined && now - lastUsedAt <= IDLE_TIMEOUT_MS) {
      lastUsedAt = now;
      return cachedToken;
    }

    let stdout: string;
    try {
      const result = await execa('gh', ['auth', 'token']);
      stdout = result.stdout;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `gh-token: failed to read GitHub CLI token. Run \`gh auth login\` to authenticate, or install gh from https://cli.github.com if missing. (${message})`,
        { cause: err },
      );
    }
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(
        'gh-token: `gh auth token` returned no output. Run `gh auth login` to authenticate.',
      );
    }

    cachedToken = trimmed;
    lastUsedAt = Date.now();
    return cachedToken;
  },
};
