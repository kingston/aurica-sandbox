import { describe, expect, it } from 'vitest';

import { CredentialCache } from './cache.js';
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

describe('CredentialCache', () => {
  it('caches a hit and does not re-resolve', async () => {
    const { provider, calls } = counterProvider();
    const cache = new CredentialCache({
      idleTimeoutSeconds: 60,
      providers: [provider],
    });
    const a = await cache.resolve('env:FOO');
    const b = await cache.resolve('env:FOO');
    expect(a).toBe(b);
    expect(calls()).toBe(1);
  });

  it('evicts on idle timeout and re-resolves', async () => {
    const { provider, calls } = counterProvider();
    let now = 1_000_000;
    const cache = new CredentialCache({
      idleTimeoutSeconds: 1,
      providers: [provider],
      now: () => now,
    });
    const first = await cache.resolve('env:FOO');
    now += 2000;
    const second = await cache.resolve('env:FOO');
    expect(first).not.toBe(second);
    expect(calls()).toBe(2);
  });

  it('refreshes lastUsedAt on hit so an active key never expires', async () => {
    const { provider, calls } = counterProvider();
    let now = 1_000_000;
    const cache = new CredentialCache({
      idleTimeoutSeconds: 5,
      providers: [provider],
      now: () => now,
    });
    await cache.resolve('env:FOO');
    now += 4000;
    await cache.resolve('env:FOO'); // bumps lastUsedAt
    now += 4000;
    await cache.resolve('env:FOO'); // still cached, total 8s elapsed
    expect(calls()).toBe(1);
  });

  it('throws on unknown scheme', async () => {
    const cache = new CredentialCache({ idleTimeoutSeconds: 60 });
    await expect(cache.resolve('foo:BAR')).rejects.toThrow(
      /No credential provider registered/,
    );
  });
});
