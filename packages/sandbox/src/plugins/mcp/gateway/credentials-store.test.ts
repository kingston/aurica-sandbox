import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteUpstreamSlot,
  readCredentials,
  readUpstreamSlot,
  withCredentials,
  writeUpstreamSlot,
} from './credentials-store.js';

describe('credentials store', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-creds-'));
    file = path.join(dir, 'credentials.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the empty default when the file does not exist', async () => {
    const f = await readCredentials(file);
    expect(f).toEqual({ version: 1, upstreams: {} });
  });

  it('round-trips an upstream slot through withCredentials', async () => {
    await withCredentials((f) => {
      f.upstreams.github = {
        clientInformation: { client_id: 'abc' },
        tokens: { access_token: 'xyz' },
      };
    }, file);
    const slot = await readUpstreamSlot('github', file);
    expect(slot?.clientInformation).toEqual({ client_id: 'abc' });
    expect(slot?.tokens).toEqual({ access_token: 'xyz' });
  });

  it('writeUpstreamSlot creates the slot atomically', async () => {
    await writeUpstreamSlot('linear', { tokens: { access_token: 't' } }, file);
    const slot = await readUpstreamSlot('linear', file);
    expect(slot?.tokens).toEqual({ access_token: 't' });
  });

  it('deleteUpstreamSlot returns true on hit and removes the entry', async () => {
    await writeUpstreamSlot('sentry', { tokens: { access_token: 't' } }, file);
    const existed = await deleteUpstreamSlot('sentry', file);
    expect(existed).toBe(true);
    const after = await readUpstreamSlot('sentry', file);
    expect(after).toBeUndefined();
  });

  it('deleteUpstreamSlot returns false when nothing was there', async () => {
    const existed = await deleteUpstreamSlot('nope', file);
    expect(existed).toBe(false);
  });

  it('writes the file with mode 0600', async () => {
    await writeUpstreamSlot('github', { tokens: { access_token: 't' } }, file);
    const stat = await fs.stat(file);
    // Mask off type bits, compare just the permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('serializes parallel writes so neither is lost', async () => {
    await Promise.all([
      writeUpstreamSlot('a', { tokens: { access_token: '1' } }, file),
      writeUpstreamSlot('b', { tokens: { access_token: '2' } }, file),
    ]);
    const f = await readCredentials(file);
    expect(Object.keys(f.upstreams).sort()).toEqual(['a', 'b']);
  });

  it('rejects malformed JSON', async () => {
    await fs.writeFile(file, '{ not valid');
    await expect(readCredentials(file)).rejects.toThrow(/JSON|Unexpected/);
  });
});
