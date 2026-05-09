import { describe, expect, it } from 'vitest';

import { shellCredentialProvider } from './shell.js';

describe('shellCredentialProvider', () => {
  it('returns trimmed stdout from the command', async () => {
    const value = await shellCredentialProvider.resolve({
      scheme: 'shell',
      name: 'printf "secret-token\\n"',
    });
    expect(value).toBe('secret-token');
  });

  it('throws when the command exits non-zero', async () => {
    await expect(
      shellCredentialProvider.resolve({
        scheme: 'shell',
        name: 'exit 1',
      }),
    ).rejects.toThrow(/shell: credential command failed/);
  });

  it('throws when stdout is empty', async () => {
    await expect(
      shellCredentialProvider.resolve({
        scheme: 'shell',
        name: 'printf ""',
      }),
    ).rejects.toThrow(/produced no output/);
  });
});
