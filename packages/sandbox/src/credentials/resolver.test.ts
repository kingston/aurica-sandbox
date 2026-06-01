import { describe, expect, it } from 'vitest';

import { CredentialResolver } from './resolver.js';
import type { CredentialProvider } from './types.js';

function counterProvider(): {
  provider: CredentialProvider;
  calls: () => number;
} {
  let n = 0;
  const provider: CredentialProvider = {
    scheme: 'env',
    resolve(source) {
      n += 1;
      return Promise.resolve(`value-of-${source.name}-${n}`);
    },
  };
  return { provider, calls: () => n };
}

describe('CredentialResolver', () => {
  it('delegates resolve to the matching provider', async () => {
    const { provider, calls } = counterProvider();
    const resolver = new CredentialResolver({ providers: [provider] });
    const result = await resolver.resolve('env:FOO');
    expect(result).toBe('value-of-FOO-1');
    expect(calls()).toBe(1);
  });

  it('calls provider on every resolve (no caching)', async () => {
    const { provider, calls } = counterProvider();
    const resolver = new CredentialResolver({ providers: [provider] });
    const a = await resolver.resolve('env:FOO');
    const b = await resolver.resolve('env:FOO');
    expect(a).not.toBe(b);
    expect(calls()).toBe(2);
  });

  it('throws on unknown scheme', async () => {
    const resolver = new CredentialResolver({ providers: [] });
    await expect(resolver.resolve('foo:BAR')).rejects.toThrow(
      /No credential provider registered/,
    );
  });
});
