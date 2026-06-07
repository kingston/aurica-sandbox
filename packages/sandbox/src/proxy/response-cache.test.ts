import { vol } from 'memfs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheKey, readCache, writeCache } from './response-cache.js';

vi.mock('node:fs');
vi.mock('node:fs/promises');

const AURICA_HOME = '/aurica-test';
const URL = 'https://downloads.cursor.com/production/abc123/reh.tar.gz';

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(`${AURICA_HOME}/sandbox`, { recursive: true });
  process.env.AURICA_HOME = AURICA_HOME;
});

afterEach(() => {
  delete process.env.AURICA_HOME;
  vi.useRealTimers();
});

describe('cacheKey', () => {
  it('is stable for the same method + url and case-insensitive on method', () => {
    expect(cacheKey('GET', URL)).toBe(cacheKey('get', URL));
  });

  it('differs by url', () => {
    expect(cacheKey('GET', URL)).not.toBe(cacheKey('GET', `${URL}?v=2`));
  });
});

describe('readCache / writeCache', () => {
  it('round-trips a stored GET 200 response', async () => {
    const body = Buffer.from('tarball-bytes');
    await writeCache('GET', URL, {
      statusCode: 200,
      headers: { 'content-type': 'application/gzip' },
      body,
      ttlSeconds: 3600,
    });

    const hit = await readCache('GET', URL);
    expect(hit).not.toBeNull();
    expect(hit?.statusCode).toBe(200);
    expect(hit?.headers).toEqual({ 'content-type': 'application/gzip' });
    expect(hit?.body.equals(body)).toBe(true);
  });

  it('returns null for an absent entry', async () => {
    expect(await readCache('GET', 'https://example.com/missing')).toBeNull();
  });

  it('returns null once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await writeCache('GET', URL, {
      statusCode: 200,
      headers: {},
      body: Buffer.from('x'),
      ttlSeconds: 60,
    });

    // Within TTL.
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    expect(await readCache('GET', URL)).not.toBeNull();

    // Past TTL.
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(await readCache('GET', URL)).toBeNull();
  });

  it('does not store non-GET requests', async () => {
    await writeCache('POST', URL, {
      statusCode: 200,
      headers: {},
      body: Buffer.from('x'),
      ttlSeconds: 60,
    });
    expect(await readCache('POST', URL)).toBeNull();
  });

  it('does not store non-200 responses', async () => {
    await writeCache('GET', URL, {
      statusCode: 404,
      headers: {},
      body: Buffer.from('nope'),
      ttlSeconds: 60,
    });
    expect(await readCache('GET', URL)).toBeNull();
  });
});
