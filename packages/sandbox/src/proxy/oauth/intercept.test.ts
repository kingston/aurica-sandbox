import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResponseInterceptor } from '#src/config/index.js';
import { defaultCredentialStore } from '#src/credentials/credential-store.js';
import { defineOAuthRecord } from '#src/credentials/oauth-record.js';

import {
  applyOAuthTokenInterceptor,
  tryShortCircuitRefresh,
} from './intercept.js';
import { _resetInflightForTests } from './refresh.js';

const interceptor: ResponseInterceptor = {
  kind: 'oauth-token-response',
  recordKey: 'claude-code:oauth',
  placeholders: {
    accessToken: 'sk-ant-oat01-aurica-PLACEHOLDER-ACCESS',
    refreshToken: 'sk-ant-ort01-aurica-PLACEHOLDER-REFRESH',
  },
};

const claudeRecord = defineOAuthRecord(interceptor.recordKey);

describe('applyOAuthTokenInterceptor', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-intercept-'));
    prevHome = process.env.AURICA_HOME;
    process.env.AURICA_HOME = dir;
    _resetInflightForTests();
  });

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.AURICA_HOME;
    } else {
      process.env.AURICA_HOME = prevHome;
    }
    await fs.rm(dir, { recursive: true, force: true });
    _resetInflightForTests();
  });

  it('captures real tokens to the slot + rewrites the body with placeholders + counter 0', async () => {
    const upstreamBody = JSON.stringify({
      access_token: 'real-access',
      refresh_token: 'real-refresh',
      expires_in: 28_800,
      scope: 'user:inference user:profile',
      subscriptionType: 'max',
    });
    const result = await applyOAuthTokenInterceptor(interceptor, {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(upstreamBody.length),
      },
      body: Buffer.from(upstreamBody, 'utf8'),
    });
    expect(result).not.toBeNull();
    if (result === null) return;

    const rewritten = JSON.parse(result.body) as Record<string, unknown>;
    expect(rewritten.access_token).toBe(interceptor.placeholders.accessToken);
    // Refresh placeholder is seeded with `:0` on authorization_code grants.
    expect(rewritten.refresh_token).toBe(
      `${interceptor.placeholders.refreshToken}:0`,
    );
    expect(rewritten.scope).toBe('user:inference user:profile');
    expect(rewritten.subscriptionType).toBe('max');
    // Real upstream expiry passes through (no more far-future sentinel).
    expect(rewritten.expires_in).toBe(28_800);

    // Real tokens went to the slot, not into the body.
    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot?.accessToken).toBe('real-access');
    expect(slot?.refreshToken).toBe('real-refresh');
    expect(slot?.scopes).toEqual(['user:inference', 'user:profile']);
    expect(slot?.extras.subscriptionType).toBe('max');
    expect(slot?.currentCounter).toBe(0);
    // The slot caches the exact bytes the proxy returned for replay.
    expect(slot?.lastResponseBody).toBe(result.body);

    // content-length is dropped so mockttp recomputes.
    expect(result.headers['content-length']).toBeUndefined();
  });

  it('returns null on a non-2xx upstream (forwards unchanged)', async () => {
    const result = await applyOAuthTokenInterceptor(interceptor, {
      statusCode: 400,
      headers: {},
      body: Buffer.from('{"error":"invalid_grant"}', 'utf8'),
    });
    expect(result).toBeNull();
    expect(await defaultCredentialStore.read(claudeRecord)).toBeUndefined();
  });

  it('returns null on malformed JSON (forwards unchanged)', async () => {
    const result = await applyOAuthTokenInterceptor(interceptor, {
      statusCode: 200,
      headers: {},
      body: Buffer.from('{not json', 'utf8'),
    });
    expect(result).toBeNull();
    expect(await defaultCredentialStore.read(claudeRecord)).toBeUndefined();
  });

  it('returns null for a non-refresh grant (e.g. authorization_code)', async () => {
    const result = await tryShortCircuitRefresh(interceptor, {
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'abc',
      }),
    });
    expect(result).toBeNull();
  });

  it('returns null on a non-JSON body (lets upstream handle)', async () => {
    const result = await tryShortCircuitRefresh(interceptor, {
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: 'grant_type=refresh_token&refresh_token=foo',
    });
    expect(result).toBeNull();
  });

  it('forwards counter-aware refresh through the configured refresher', async () => {
    let calledInbound: number | undefined;
    const result = await tryShortCircuitRefresh(interceptor, {
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:7`,
      }),
      refresher: (opts) => {
        calledInbound = opts.inboundCounter;
        return Promise.resolve({
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"replayed":"from-test"}',
          mutations: [],
        });
      },
    });
    expect(calledInbound).toBe(7);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('{"replayed":"from-test"}');
  });

  it('treats a placeholder without a `:<n>` suffix as counter 0', async () => {
    let calledInbound: number | undefined;
    await tryShortCircuitRefresh(interceptor, {
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: interceptor.placeholders.refreshToken,
      }),
      refresher: (opts) => {
        calledInbound = opts.inboundCounter;
        return Promise.resolve({
          statusCode: 200,
          headers: {},
          body: '{}',
          mutations: [],
        });
      },
    });
    expect(calledInbound).toBe(0);
  });

  it('handles missing scope field (defaults to empty array)', async () => {
    const result = await applyOAuthTokenInterceptor(interceptor, {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 60,
        }),
        'utf8',
      ),
    });
    expect(result).not.toBeNull();
    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot?.scopes).toEqual([]);
  });
});
