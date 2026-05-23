import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readState, withState } from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';

import { runStop } from './stop.js';

const sampleSandbox = {
  name: 'a',
  projectDir: '/tmp/proj',
  status: 'running' as const,
  ip: '192.168.1.10',
  createdAt: '2026-01-01T00:00:00.000Z',
  authSecret: 'test-secret',
  kind: 'primary' as const,
};

describe('runStop', () => {
  let dir: string;
  let originalAuricaHome: string | undefined;
  let originalStdoutWrite: typeof process.stdout.write;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-stop-'));
    originalAuricaHome = process.env.AURICA_HOME;
    process.env.AURICA_HOME = dir;
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    vi.spyOn(defaultProvider, 'stopVM').mockImplementation(() =>
      Promise.resolve(),
    );
  });

  afterEach(async () => {
    if (originalAuricaHome === undefined) delete process.env.AURICA_HOME;
    else process.env.AURICA_HOME = originalAuricaHome;
    process.stdout.write = originalStdoutWrite;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('flips status to stopped, clears IP, and calls orbctl stop', async () => {
    await withState((s) => {
      s.sandboxes.a = { ...sampleSandbox };
    });
    await runStop('a');
    const after = await readState();
    expect(after.sandboxes.a?.status).toBe('stopped');
    expect(after.sandboxes.a?.ip).toBeNull();
    expect(defaultProvider.stopVM).toHaveBeenCalledWith('a');
  });

  it('no-ops when already stopped', async () => {
    await withState((s) => {
      s.sandboxes.a = { ...sampleSandbox, status: 'stopped', ip: null };
    });
    await runStop('a');
    expect(defaultProvider.stopVM).not.toHaveBeenCalled();
  });

  it('throws on unknown sandbox', async () => {
    await expect(runStop('nope')).rejects.toThrow(/not found/);
  });
});
