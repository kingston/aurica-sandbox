import { execa } from 'execa';

import type { CredentialProvider, CredentialSource } from '../types.js';

/**
 * Resolves credentials of the form `shell:<command>` by running the command in
 * the user's shell and returning trimmed stdout. Example: `shell:gh auth token`.
 *
 * The command runs with `shell: true`, so pipes, env interpolation, and quoting
 * follow the host shell's rules. A non-zero exit or empty stdout is an error.
 */
export const shellCredentialProvider: CredentialProvider = {
  scheme: 'shell',
  async resolve(source: CredentialSource): Promise<string> {
    const command = source.name;
    let stdout: string;
    try {
      const result = await execa(command, { shell: true });
      stdout = result.stdout;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `shell: credential command failed (${JSON.stringify(command)}): ${message}`,
        { cause: err },
      );
    }
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(
        `shell: credential command produced no output (${JSON.stringify(command)})`,
      );
    }
    return trimmed;
  },
};
