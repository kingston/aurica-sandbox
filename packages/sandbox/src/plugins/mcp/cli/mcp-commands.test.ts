import { describe, expect, it } from 'vitest';

import {
  collectAuthCode,
  parseCodeOrUrlInput,
  type CollectAuthCodeOptions,
} from './mcp-commands.js';

describe('parseCodeOrUrlInput', () => {
  it('returns null for empty input', () => {
    expect(parseCodeOrUrlInput('')).toBeNull();
    expect(parseCodeOrUrlInput('   ')).toBeNull();
  });

  it('returns the trimmed value when it is not a URL (bare code)', () => {
    expect(parseCodeOrUrlInput('abc123')).toBe('abc123');
    expect(parseCodeOrUrlInput('  abc123  ')).toBe('abc123');
  });

  it('extracts the `code` parameter when the input is a redirect URL', () => {
    expect(
      parseCodeOrUrlInput('http://127.0.0.1:1234/callback?code=xyz&state=qq'),
    ).toBe('xyz');
    expect(
      parseCodeOrUrlInput('HTTPS://example.com/cb?code=upper-case-scheme'),
    ).toBe('upper-case-scheme');
  });

  it('throws when the pasted URL carries an `error` parameter', () => {
    expect(() =>
      parseCodeOrUrlInput('http://127.0.0.1/cb?error=access_denied'),
    ).toThrow(/access_denied/);
  });

  it('throws when the pasted URL has no `code` parameter', () => {
    expect(() => parseCodeOrUrlInput('http://127.0.0.1/cb?state=foo')).toThrow(
      /no `code` parameter/,
    );
  });

  it('throws for malformed URLs that still look URL-like', () => {
    expect(() => parseCodeOrUrlInput('http://')).toThrow(/Invalid URL/);
  });
});

/**
 * Build a stub {@link LoginCallback} whose `awaitCode` resolves only
 * when the test calls `resolve(...)`. Lets each test sequence the race
 * deterministically.
 */
function fakeCallback(): {
  callback: Parameters<typeof collectAuthCode>[0];
  resolve: (code: string) => void;
  closed: () => boolean;
} {
  let resolveFn!: (code: string) => void;
  const promise = new Promise<string>((r) => {
    resolveFn = r;
  });
  let isClosed = false;
  return {
    callback: {
      url: 'http://127.0.0.1:0/callback',
      awaitCode: () => promise,
      close: () => {
        isClosed = true;
      },
    },
    resolve: resolveFn,
    closed: () => isClosed,
  };
}

describe('collectAuthCode', () => {
  it('returns the loopback code immediately when non-interactive', async () => {
    const { callback, resolve } = fakeCallback();
    const promise = collectAuthCode(callback, {
      interactive: false,
      readLine: () => {
        throw new Error('readLine must not be called when non-interactive');
      },
    });
    resolve('from-loopback');
    await expect(promise).resolves.toBe('from-loopback');
  });

  it('aborts the paste prompt when the loopback callback wins the race', async () => {
    const { callback, resolve } = fakeCallback();
    let abortedAt: 'before' | 'after' = 'before';
    const readLine: CollectAuthCodeOptions['readLine'] = (signal) =>
      new Promise<string | null>((res) => {
        signal.addEventListener('abort', () => {
          abortedAt = 'after';
          res(null);
        });
      });
    const promise = collectAuthCode(callback, { interactive: true, readLine });
    // Loopback finishes before the user pastes.
    resolve('from-loopback');
    await expect(promise).resolves.toBe('from-loopback');
    expect(abortedAt).toBe('after');
  });

  it('uses a pasted bare code as the result when paste wins the race', async () => {
    const { callback } = fakeCallback();
    const readLine: CollectAuthCodeOptions['readLine'] = () =>
      Promise.resolve('pasted-code');
    await expect(
      collectAuthCode(callback, { interactive: true, readLine }),
    ).resolves.toBe('pasted-code');
  });

  it('extracts the code from a pasted redirect URL', async () => {
    const { callback } = fakeCallback();
    const readLine: CollectAuthCodeOptions['readLine'] = () =>
      Promise.resolve('http://127.0.0.1:9999/callback?code=url-code&state=x');
    await expect(
      collectAuthCode(callback, { interactive: true, readLine }),
    ).resolves.toBe('url-code');
  });

  it('falls back to the loopback callback when the user submits an empty line', async () => {
    const { callback, resolve } = fakeCallback();
    const readLine: CollectAuthCodeOptions['readLine'] = () =>
      Promise.resolve('');
    const promise = collectAuthCode(callback, { interactive: true, readLine });
    resolve('from-loopback-after-empty-paste');
    await expect(promise).resolves.toBe('from-loopback-after-empty-paste');
  });

  it('propagates URL-parse errors from the paste', async () => {
    const { callback } = fakeCallback();
    const readLine: CollectAuthCodeOptions['readLine'] = () =>
      Promise.resolve('http://example.com/cb?error=denied');
    await expect(
      collectAuthCode(callback, { interactive: true, readLine }),
    ).rejects.toThrow(/denied/);
  });
});
