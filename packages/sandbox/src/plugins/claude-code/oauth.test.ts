import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultCredentialStore } from '#src/credentials/credential-store.js';

import { ClaudeNotLoggedInError, claudeRecord } from './oauth.js';

describe('claudeRecord (subscription mode)', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-claude-slot-'));
    prevHome = process.env.AURICA_HOME;
    process.env.AURICA_HOME = dir;
  });

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.AURICA_HOME;
    } else {
      process.env.AURICA_HOME = prevHome;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exposes its slot key so the proxy interceptor can target it', () => {
    expect(claudeRecord.key).toBe('claude-code:oauth');
  });

  it('returns undefined when nothing has been written (logged out)', async () => {
    expect(await defaultCredentialStore.read(claudeRecord)).toBeUndefined();
  });

  it('round-trips a full slot through write + read', async () => {
    const now = Date.now();
    await defaultCredentialStore.write(claudeRecord, {
      accessToken: 'sk-ant-oat01-real-access',
      refreshToken: 'sk-ant-ort01-real-refresh',
      expiresAt: now + 3_600_000,
      obtainedAt: now,
      scopes: ['user:inference', 'user:profile'],
      extras: { subscriptionType: 'max' },
      currentCounter: 3,
      lastResponseBody: '{"replay":"body"}',
    });
    const slot = await defaultCredentialStore.read(claudeRecord);
    expect(slot).toEqual({
      accessToken: 'sk-ant-oat01-real-access',
      refreshToken: 'sk-ant-ort01-real-refresh',
      expiresAt: now + 3_600_000,
      obtainedAt: now,
      scopes: ['user:inference', 'user:profile'],
      extras: { subscriptionType: 'max' },
      currentCounter: 3,
      lastResponseBody: '{"replay":"body"}',
    });
  });

  it('splits secrets and metadata into the two stores on write', async () => {
    const now = Date.now();
    await defaultCredentialStore.write(claudeRecord, {
      accessToken: 'access-real',
      refreshToken: 'refresh-real',
      expiresAt: now,
      obtainedAt: now,
      scopes: ['x'],
      currentCounter: 0,
      extras: {},
    });
    const metadataRaw = await fs.readFile(
      path.join(dir, 'sandbox', 'credentials.json'),
      'utf8',
    );
    const secretsRaw = await fs.readFile(
      path.join(dir, 'sandbox', 'secrets.json'),
      'utf8',
    );
    // Secrets land only in secrets.json; metadata never sees them.
    expect(metadataRaw).not.toContain('access-real');
    expect(metadataRaw).not.toContain('refresh-real');
    expect(secretsRaw).toContain('access-real');
    expect(secretsRaw).toContain('refresh-real');
  });

  it('delete returns true on a hit and clears both halves', async () => {
    const now = Date.now();
    await defaultCredentialStore.write(claudeRecord, {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: now,
      obtainedAt: now,
      scopes: [],
      currentCounter: 0,
      extras: {},
    });
    expect(await defaultCredentialStore.delete(claudeRecord)).toBe(true);
    expect(await defaultCredentialStore.read(claudeRecord)).toBeUndefined();
  });

  it('delete returns false when there was nothing to delete', async () => {
    expect(await defaultCredentialStore.delete(claudeRecord)).toBe(false);
  });
});

describe('ClaudeNotLoggedInError', () => {
  it('carries a name + actionable message', () => {
    const err = new ClaudeNotLoggedInError();
    expect(err.name).toBe('ClaudeNotLoggedInError');
    expect(err.message).toMatch(/claude \/login/);
  });
});
