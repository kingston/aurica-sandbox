import { vol } from 'memfs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CredentialStore } from './credential-store.js';
import { defineCredentialRecord } from './credential-record.js';

vi.mock('node:fs');
vi.mock('node:fs/promises');
// proper-lockfile uses graceful-fs (a real-fs wrapper) and creates lock
// directories on disk. Replace with a passthrough no-op so tests stay in-memory.
vi.mock('proper-lockfile', () => ({
  default: {
    lock: vi.fn<() => Promise<() => Promise<void>>>().mockResolvedValue(() => Promise.resolve()),
  },
}));

const AURICA_HOME = '/aurica-test';

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(`${AURICA_HOME}/sandbox`, { recursive: true });
  process.env.AURICA_HOME = AURICA_HOME;
});

afterEach(() => {
  delete process.env.AURICA_HOME;
});

// A record with metadata + one secret field.
const tokenRecord = defineCredentialRecord({
  key: 'test:token',
  metadataSchema: z.object({ label: z.string() }),
  secretFields: ['accessToken'],
});

// A metadata-free record (everything in the vault).
const opaqueRecord = defineCredentialRecord({
  key: 'test:opaque',
  metadataSchema: z.object({}),
  secretFields: ['blob'],
});

// A record with multiple secret fields.
const multiRecord = defineCredentialRecord({
  key: 'test:multi',
  metadataSchema: z.object({ userId: z.string() }),
  secretFields: ['accessToken', 'refreshToken'],
});

describe('CredentialStore.read', () => {
  it('returns undefined when no credential has been written', async () => {
    const store = new CredentialStore();
    expect(await store.read(tokenRecord)).toBeUndefined();
  });

  it('returns the full bundle after a write', async () => {
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'my-label', accessToken: 'tok-abc' });

    const result = await store.read(tokenRecord);
    expect(result).toEqual({ label: 'my-label', accessToken: 'tok-abc' });
  });

  it('returns undefined when the metadata record exists but a secret is missing', async () => {
    // Write metadata directly without touching the vault.
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'partial', accessToken: 'tok' });

    // Corrupt the vault by removing the secret file.
    const secretsPath = `${AURICA_HOME}/sandbox/secrets.json`;
    vol.writeFileSync(secretsPath, JSON.stringify({ version: 1, secrets: {} }));

    expect(await store.read(tokenRecord)).toBeUndefined();
  });

  it('handles metadata-free (opaque) records', async () => {
    const store = new CredentialStore();
    await store.write(opaqueRecord, { blob: '{"hello":"world"}' });

    const result = await store.read(opaqueRecord);
    expect(result?.blob).toBe('{"hello":"world"}');
  });

  it('returns all secret fields for multi-secret records', async () => {
    const store = new CredentialStore();
    await store.write(multiRecord, {
      userId: 'u1',
      accessToken: 'at',
      refreshToken: 'rt',
    });

    const result = await store.read(multiRecord);
    expect(result).toEqual({ userId: 'u1', accessToken: 'at', refreshToken: 'rt' });
  });
});

describe('CredentialStore.write', () => {
  it('secrets land in secrets.json, metadata in credentials.json', async () => {
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'x', accessToken: 'secret-val' });

    const credFile = JSON.parse(
      vol.readFileSync(`${AURICA_HOME}/sandbox/credentials.json`, 'utf8') as string,
    ) as { records: Record<string, unknown> };
    const secretFile = JSON.parse(
      vol.readFileSync(`${AURICA_HOME}/sandbox/secrets.json`, 'utf8') as string,
    ) as { secrets: Record<string, string> };

    expect(credFile.records['test:token']).toEqual({ label: 'x' });
    expect(secretFile.secrets['test:token:accessToken']).toBe('secret-val');
    // Secret must not appear in credentials.json.
    expect(JSON.stringify(credFile)).not.toContain('secret-val');
  });

  it('overwrites an existing record', async () => {
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'first', accessToken: 'tok-1' });
    await store.write(tokenRecord, { label: 'second', accessToken: 'tok-2' });

    const result = await store.read(tokenRecord);
    expect(result).toEqual({ label: 'second', accessToken: 'tok-2' });
  });

  it('does not clobber unrelated records in the same files', async () => {
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'a', accessToken: 'tok-a' });
    await store.write(opaqueRecord, { blob: 'blob-b' });

    const token = await store.read(tokenRecord);
    const opaque = await store.read(opaqueRecord);
    expect(token?.accessToken).toBe('tok-a');
    expect(opaque?.blob).toBe('blob-b');
  });
});

describe('CredentialStore.delete', () => {
  it('returns false when the record does not exist', async () => {
    const store = new CredentialStore();
    expect(await store.delete(tokenRecord)).toBe(false);
  });

  it('returns true and makes the record unreadable', async () => {
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'gone', accessToken: 'tok' });

    expect(await store.delete(tokenRecord)).toBe(true);
    expect(await store.read(tokenRecord)).toBeUndefined();
  });

  it('removes secrets from the vault on delete', async () => {
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'gone', accessToken: 'tok' });
    await store.delete(tokenRecord);

    const secretFile = JSON.parse(
      vol.readFileSync(`${AURICA_HOME}/sandbox/secrets.json`, 'utf8') as string,
    ) as { secrets: Record<string, string> };
    expect(secretFile.secrets['test:token:accessToken']).toBeUndefined();
  });

  it('does not affect other records', async () => {
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'del', accessToken: 'tok-a' });
    await store.write(opaqueRecord, { blob: 'keep' });

    await store.delete(tokenRecord);

    expect(await store.read(opaqueRecord)).toEqual({ blob: 'keep' });
  });

  it('returns false on a second delete of the same record', async () => {
    const store = new CredentialStore();
    await store.write(tokenRecord, { label: 'x', accessToken: 'tok' });
    await store.delete(tokenRecord);
    expect(await store.delete(tokenRecord)).toBe(false);
  });
});
