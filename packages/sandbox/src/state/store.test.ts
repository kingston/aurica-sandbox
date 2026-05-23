import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readState, withState } from './store.js';
import type { SandboxEntry } from './store.js';

const sampleEntry: SandboxEntry = {
  name: 'a',
  projectDir: '/tmp/proj',
  status: 'running',
  ip: '192.168.1.10',
  createdAt: '2026-01-01T00:00:00.000Z',
  authSecret: 'test-secret',
  kind: 'primary',
};

describe('state store', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-state-'));
    file = path.join(dir, 'state.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns an empty default when the file does not exist', async () => {
    const state = await readState(file);
    expect(state).toEqual({ version: 1, proxy: null, sandboxes: {} });
  });

  it('round-trips a write through withState', async () => {
    await withState((s) => {
      s.sandboxes.a = sampleEntry;
    }, file);
    const after = await readState(file);
    expect(after.sandboxes.a).toEqual(sampleEntry);
  });

  it('serializes parallel withState calls so neither write is lost', async () => {
    await Promise.all([
      withState((s) => {
        s.sandboxes.a = { ...sampleEntry, name: 'a' };
      }, file),
      withState((s) => {
        s.sandboxes.b = { ...sampleEntry, name: 'b' };
      }, file),
    ]);
    const after = await readState(file);
    expect(Object.keys(after.sandboxes).sort()).toEqual(['a', 'b']);
  });

  it('rejects malformed JSON', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not valid');
    await expect(readState(file)).rejects.toThrow(/JSON|Unexpected/);
  });
});
