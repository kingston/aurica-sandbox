import { execa } from 'execa';

import type { CredentialProvider } from '../types.js';

/**
 * Resolves credentials of the form `gh-token` by running `gh auth token` on
 * the host and returning trimmed stdout. Used to source the GitHub CLI's
 * stored token without requiring the user to copy it into an env var.
 *
 * Surfaces an actionable error when `gh` is missing or the user isn't
 * authenticated, since both are user-fixable with `gh auth login`.
 */
export const ghTokenCredentialProvider: CredentialProvider = {
  scheme: 'gh-token',
  async resolve(): Promise<string> {
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
    return trimmed;
  },
};
