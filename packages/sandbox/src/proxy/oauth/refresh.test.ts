import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResponseInterceptor } from '#src/config/index.js';
import { defaultCredentialStore } from '#src/credentials/credential-store.js';
import {
  defineOAuthRecord,
  type OAuthRecord,
} from '#src/credentials/oauth-record.js';

import {
  _resetInflightForTests,
  runRefresh,
  type UpstreamPoster,
} from './refresh.js';

const interceptor: ResponseInterceptor = {
  kind: 'oauth-token-response',
  recordKey: 'claude-code:oauth',
  placeholders: {
    accessToken: 'sk-ant-oat01-aurica-PLACEHOLDER-ACCESS',
    refreshToken: 'sk-ant-ort01-aurica-PLACEHOLDER-REFRESH',
  },
};

const claudeRecord = defineOAuthRecord(interceptor.recordKey);

/**
 * Seed the on-disk slot with the same shape the production interceptor
 * would write. `obtainedAt` defaults to `Date.now()` because the metadata
 * schema requires it; tests don't assert against it.
 */
async function seedSlot(overrides: Partial<OAuthRecord> = {}): Promise<void> {
  await defaultCredentialStore.write(claudeRecord, {
    accessToken: 'real-access',
    refreshToken: 'real-refresh',
    expiresAt: Date.now() + 60_000,
    obtainedAt: Date.now(),
    scopes: ['user:inference'],
    currentCounter: 0,
    extras: {},
    ...overrides,
  });
}

describe('runRefresh', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-refresh-'));
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

  it('replays the cached body when the inbound counter is behind, with recomputed expires_in', async () => {
    const expiresAt = Date.now() + 600_000; // 10 minutes out
    await seedSlot({
      currentCounter: 3,
      expiresAt,
      lastResponseBody: JSON.stringify({
        access_token: 'cached-placeholder',
        refresh_token: 'cached-placeholder:3',
        // The body was minted long ago with a now-stale expires_in;
        // replay should recompute from the slot's absolute expiresAt.
        expires_in: 9999,
        token_type: 'Bearer',
      }),
    });
    const post: UpstreamPoster = () =>
      Promise.reject(new Error('should not be called'));
    const result = await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:1`,
      }),
      inboundCounter: 1,
      post,
    });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.access_token).toBe('cached-placeholder');
    // expires_in recomputed from (expiresAt - now()), within a few seconds
    // of the original 600 (some test elapsed time eats into it).
    const remaining = body.expires_in as number;
    expect(remaining).toBeGreaterThan(595);
    expect(remaining).toBeLessThanOrEqual(600);
    // Slot was not rewritten — counter still at 3.
    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot?.currentCounter).toBe(3);
  });

  it('falls through to the leader path when the slot is past its expiry (replay would hand back a dead token)', async () => {
    await seedSlot({
      currentCounter: 3,
      expiresAt: Date.now() - 1000, // already expired
      lastResponseBody: '{"stale":"body"}',
      refreshToken: 'real-refresh-old',
    });
    let upstreamCalled = false;
    const post: UpstreamPoster = () => {
      upstreamCalled = true;
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      });
    };
    const result = await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:1`,
      }),
      inboundCounter: 1,
      post,
    });
    expect(upstreamCalled).toBe(true);
    expect(result.statusCode).toBe(200);
    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot?.currentCounter).toBe(4);
    expect(slot?.accessToken).toBe('new-access');
  });

  it('falls through to the leader path when the slot is within the freshness safety margin', async () => {
    await seedSlot({
      currentCounter: 3,
      // Real token is technically still alive, but within the 60s
      // safety margin — replay would hand the guest a token that
      // expires before its first API call.
      expiresAt: Date.now() + 30_000,
      lastResponseBody: '{"close-to-expiry":"body"}',
      refreshToken: 'real-refresh-old',
    });
    let upstreamCalled = false;
    const post: UpstreamPoster = () => {
      upstreamCalled = true;
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      });
    };
    await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:1`,
      }),
      inboundCounter: 1,
      post,
    });
    expect(upstreamCalled).toBe(true);
  });

  it('runs the leader path on equal counter: upstream POST, slot write, counter bump', async () => {
    await seedSlot({
      currentCounter: 0,
      refreshToken: 'real-refresh-old',
    });
    let sentBody: string | undefined;
    const post: UpstreamPoster = (input) => {
      sentBody = input.body;
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'real-access-new',
          refresh_token: 'real-refresh-new',
          expires_in: 3600,
          scope: 'user:inference user:profile',
        }),
      });
    };
    const result = await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:0`,
      }),
      inboundCounter: 0,
      post,
    });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.access_token).toBe(interceptor.placeholders.accessToken);
    expect(body.refresh_token).toBe(
      `${interceptor.placeholders.refreshToken}:1`,
    );
    expect(body.expires_in).toBe(3600);

    // The body sent upstream carried the REAL refresh token, not the placeholder.
    expect(sentBody).toBeDefined();
    const sent = JSON.parse(sentBody ?? '{}') as Record<string, unknown>;
    expect(sent.refresh_token).toBe('real-refresh-old');

    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot?.currentCounter).toBe(1);
    expect(slot?.accessToken).toBe('real-access-new');
    expect(slot?.refreshToken).toBe('real-refresh-new');
    expect(slot?.lastResponseBody).toBe(result.body);
  });

  it('returns 400 when the inbound counter is ahead of the slot', async () => {
    await seedSlot({ currentCounter: 2 });
    const post: UpstreamPoster = () =>
      Promise.reject(new Error('should not be called'));
    const result = await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:5`,
      }),
      inboundCounter: 5,
      post,
    });
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/ahead of slot counter 2/);
    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot?.currentCounter).toBe(2);
  });

  it('returns 400 invalid_grant when the slot is empty', async () => {
    const post: UpstreamPoster = () =>
      Promise.reject(new Error('should not be called'));
    const result = await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:0`,
      }),
      inboundCounter: 0,
      post,
    });
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  it('serializes parallel refreshes: leader hits upstream once, followers replay', async () => {
    await seedSlot({ currentCounter: 0 });
    let upstreamCalls = 0;
    let resolveUpstream: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveUpstream = r;
    });
    const post: UpstreamPoster = async () => {
      upstreamCalls++;
      await gate;
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      };
    };
    const opts = {
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:0`,
      }),
      inboundCounter: 0,
      post,
    };
    const calls = [runRefresh(opts), runRefresh(opts), runRefresh(opts)];
    expect(resolveUpstream).toBeDefined();
    if (resolveUpstream !== undefined) resolveUpstream();
    const results = await Promise.all(calls);
    // Upstream POST happens exactly once for the burst.
    expect(upstreamCalls).toBe(1);
    // All callers see the same synthesized body (followers replay cached
    // bytes after the leader writes).
    expect(results[0]?.statusCode).toBe(200);
    expect(results[0]?.body).toBe(results[1]?.body);
    expect(results[1]?.body).toBe(results[2]?.body);
    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot?.currentCounter).toBe(1);
  });

  it('returns 502 when the upstream POST fails', async () => {
    await seedSlot({ currentCounter: 0 });
    const post: UpstreamPoster = () =>
      Promise.reject(new Error('network down'));
    const result = await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:0`,
      }),
      inboundCounter: 0,
      post,
    });
    expect(result.statusCode).toBe(502);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.error).toBe('temporarily_unavailable');
    const slot = await defaultCredentialStore.read(claudeRecord);
    // Counter unchanged — leader bailed before write.
    expect(slot?.currentCounter).toBe(0);
  });

  it('strips host/content-length/cookie from forwarded headers', async () => {
    await seedSlot({ currentCounter: 0 });
    let sentHeaders: Record<string, string> | undefined;
    const post: UpstreamPoster = (input) => {
      sentHeaders = input.headers;
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 60,
        }),
      });
    };
    await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {
        host: 'guest-host',
        'content-length': '99',
        cookie: 'secret=1',
        'content-type': 'application/json',
        'user-agent': 'Claude/test',
      },
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:0`,
      }),
      inboundCounter: 0,
      post,
    });
    expect(sentHeaders).toBeDefined();
    if (sentHeaders === undefined) return;
    expect(sentHeaders.host).toBeUndefined();
    expect(sentHeaders['content-length']).toBeUndefined();
    expect(sentHeaders.cookie).toBeUndefined();
    expect(sentHeaders['content-type']).toBe('application/json');
    expect(sentHeaders['user-agent']).toBe('Claude/test');
  });

  it('spreads slot extras onto the synthetic body (e.g. subscriptionType)', async () => {
    await seedSlot({
      currentCounter: 0,
      extras: { subscriptionType: 'max' },
    });
    const post: UpstreamPoster = () =>
      Promise.resolve({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
        }),
      });
    const result = await runRefresh({
      interceptor,
      url: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      bodyText: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: `${interceptor.placeholders.refreshToken}:0`,
      }),
      inboundCounter: 0,
      post,
    });
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.subscriptionType).toBe('max');
    // Slot's extras survive a refresh whose upstream body omits them —
    // a follower that replays from the persisted slot will see the same
    // `subscriptionType` on its next round.
    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot?.extras).toEqual({ subscriptionType: 'max' });
  });
});
