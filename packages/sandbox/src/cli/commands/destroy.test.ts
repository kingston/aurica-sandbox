import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readState, withState } from '#src/state/index.js';
import type { SandboxEntry } from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';

import { runDestroy } from './destroy.js';

function primary(name: string): SandboxEntry {
  return {
    name,
    projectDir: '/tmp/proj',
    status: 'stopped',
    ip: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    authSecret: 'test-secret',
    kind: 'primary',
  };
}

function fork(name: string, parentName: string, idx: number): SandboxEntry {
  return {
    name,
    projectDir: '/tmp/proj',
    status: 'running',
    ip: '192.168.1.10',
    createdAt: '2026-01-01T00:00:00.000Z',
    authSecret: 'test-secret',
    kind: 'fork',
    parentName,
    concurrencyIndex: idx,
  };
}

describe('runDestroy', () => {
  let dir: string;
  let originalAuricaHome: string | undefined;
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-destroy-'));
    originalAuricaHome = process.env.AURICA_HOME;
    process.env.AURICA_HOME = dir;
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    vi.spyOn(defaultProvider, 'destroyVM').mockImplementation(() =>
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

  it('destroys a lone primary and unregisters it', async () => {
    await withState((s) => {
      s.sandboxes.proj = primary('proj');
    });
    await runDestroy('proj', false);
    const after = await readState();
    expect(after.sandboxes.proj).toBeUndefined();
    expect(defaultProvider.destroyVM).toHaveBeenCalledWith('proj');
  });

  it('refuses to destroy a primary with live forks without --cascade', async () => {
    await withState((s) => {
      s.sandboxes.proj = primary('proj');
      s.sandboxes['proj-fork-1'] = fork('proj-fork-1', 'proj', 1);
    });
    await expect(runDestroy('proj', false)).rejects.toThrow(
      /fork\(s\) still exist/,
    );
    // Nothing destroyed — the refusal happens before any VM is touched.
    expect(defaultProvider.destroyVM).not.toHaveBeenCalled();
    const after = await readState();
    expect(after.sandboxes.proj).toBeDefined();
    expect(after.sandboxes['proj-fork-1']).toBeDefined();
  });

  it('cascade destroys all forks then the primary', async () => {
    await withState((s) => {
      s.sandboxes.proj = primary('proj');
      s.sandboxes['proj-fork-1'] = fork('proj-fork-1', 'proj', 1);
      s.sandboxes['proj-fork-2'] = fork('proj-fork-2', 'proj', 2);
    });
    await runDestroy('proj', false, true);

    const after = await readState();
    expect(after.sandboxes).toEqual({});
    const destroyed = vi
      .mocked(defaultProvider.destroyVM)
      .mock.calls.map((c) => c[0]);
    expect(new Set(destroyed)).toEqual(
      new Set(['proj-fork-1', 'proj-fork-2', 'proj']),
    );
    // Primary is destroyed last.
    expect(destroyed.at(-1)).toBe('proj');
  });

  it('destroys a fork directly without touching its primary', async () => {
    await withState((s) => {
      s.sandboxes.proj = primary('proj');
      s.sandboxes['proj-fork-1'] = fork('proj-fork-1', 'proj', 1);
    });
    await runDestroy('proj-fork-1', false);

    const after = await readState();
    expect(after.sandboxes['proj-fork-1']).toBeUndefined();
    expect(after.sandboxes.proj).toBeDefined();
    expect(defaultProvider.destroyVM).toHaveBeenCalledWith('proj-fork-1');
    expect(defaultProvider.destroyVM).not.toHaveBeenCalledWith('proj');
  });

  it('throws on an unregistered sandbox without --force', async () => {
    await expect(runDestroy('nope', false)).rejects.toThrow(/not found/);
  });
});
