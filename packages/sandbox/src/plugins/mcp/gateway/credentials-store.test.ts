import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteUpstreamRecord,
  readUpstreamRecord,
  writeUpstreamRecord,
} from './credentials-store.js';

describe('mcp credentials store (slot-backed)', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-mcp-creds-'));
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

  it('returns undefined when nothing has been written for an upstream', async () => {
    expect(await readUpstreamRecord('github')).toBeUndefined();
  });

  it('round-trips client + tokens through writeUpstreamRecord', async () => {
    await writeUpstreamRecord('github', {
      clientInformation: { client_id: 'abc' },
      tokens: { access_token: 'xyz' },
    });
    const slot = await readUpstreamRecord('github');
    expect(slot?.clientInformation).toEqual({ client_id: 'abc' });
    expect(slot?.tokens).toEqual({ access_token: 'xyz' });
  });

  it('writeUpstreamRecord can write tokens alone', async () => {
    await writeUpstreamRecord('linear', { tokens: { access_token: 't' } });
    const slot = await readUpstreamRecord('linear');
    expect(slot?.tokens).toEqual({ access_token: 't' });
    expect(slot?.clientInformation).toBeUndefined();
  });

  it('deleteUpstreamRecord returns true on hit and removes both halves', async () => {
    await writeUpstreamRecord('sentry', {
      clientInformation: { client_id: 'c' },
      tokens: { access_token: 't' },
    });
    const existed = await deleteUpstreamRecord('sentry');
    expect(existed).toBe(true);
    expect(await readUpstreamRecord('sentry')).toBeUndefined();
  });

  it('deleteUpstreamRecord returns false when nothing was there', async () => {
    expect(await deleteUpstreamRecord('nope')).toBe(false);
  });

  it('scopes per-upstream: writes to a do not bleed into b', async () => {
    await Promise.all([
      writeUpstreamRecord('a', { tokens: { access_token: '1' } }),
      writeUpstreamRecord('b', { tokens: { access_token: '2' } }),
    ]);
    const [aSlot, bSlot] = await Promise.all([
      readUpstreamRecord('a'),
      readUpstreamRecord('b'),
    ]);
    expect(aSlot?.tokens).toEqual({ access_token: '1' });
    expect(bSlot?.tokens).toEqual({ access_token: '2' });
  });
});
