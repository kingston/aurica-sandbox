import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readState, withState } from '#src/state/index.js';
import type { SandboxEntry } from '#src/state/index.js';
import type { SandboxVM } from '#src/vm/types.js';

import {
  type ReconcileProvider,
  formatReconcileSummary,
  reconcileRegistry,
} from './reconcile.js';

const baseEntry: SandboxEntry = {
  name: 'a',
  projectDir: '/tmp/proj',
  status: 'running',
  ip: '192.168.1.10',
  createdAt: '2026-01-01T00:00:00.000Z',
  authSecret: 'secret',
  kind: 'primary',
};

/** Build a provider whose list/info are driven by the given maps. */
function fakeProvider(
  list: SandboxVM[],
  info: Record<string, SandboxVM | (() => never)> = {},
): ReconcileProvider {
  return {
    listVMs: vi.fn<ReconcileProvider['listVMs']>(() => Promise.resolve(list)),
    infoVM: vi.fn<ReconcileProvider['infoVM']>((name) => {
      const entry = info[name];
      if (typeof entry === 'function') return Promise.resolve(entry());
      if (entry) return Promise.resolve(entry);
      return Promise.resolve({ name });
    }),
  };
}

describe('reconcileRegistry', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-reconcile-'));
    file = path.join(dir, 'state.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seed(entry: SandboxEntry): Promise<void> {
    await withState((s) => {
      s.sandboxes[entry.name] = entry;
    }, file);
  }

  it('marks a running entry stopped when the VM is stopped', async () => {
    await seed({ ...baseEntry, status: 'running', ip: '192.168.1.10' });
    const provider = fakeProvider([{ name: 'a', state: 'stopped' }]);
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([{ name: 'a', kind: 'stopped', ip: null }]);
    const after = await readState(file);
    expect(after.sandboxes.a).toMatchObject({ status: 'stopped', ip: null });
  });

  it('marks a stopped entry running with its fresh IP', async () => {
    await seed({ ...baseEntry, status: 'stopped', ip: null });
    const provider = fakeProvider([{ name: 'a', state: 'running' }], {
      a: { name: 'a', state: 'running', networkInfo: { ipV4: '10.0.0.5' } },
    });
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      { name: 'a', kind: 'started', ip: '10.0.0.5' },
    ]);
    const after = await readState(file);
    expect(after.sandboxes.a).toMatchObject({
      status: 'running',
      ip: '10.0.0.5',
    });
  });

  it('commits a started entry with ip null when info has no IP', async () => {
    await seed({ ...baseEntry, status: 'stopped', ip: null });
    const provider = fakeProvider([{ name: 'a', state: 'running' }], {
      a: { name: 'a', state: 'running' },
    });
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changes).toEqual([{ name: 'a', kind: 'started', ip: null }]);
    const after = await readState(file);
    expect(after.sandboxes.a).toMatchObject({ status: 'running', ip: null });
  });

  it('removes an entry whose VM vanished from the provider', async () => {
    await seed({ ...baseEntry, status: 'running' });
    const provider = fakeProvider([]); // VM gone
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changes).toEqual([{ name: 'a', kind: 'vanished' }]);
    const after = await readState(file);
    expect(after.sandboxes.a).toBeUndefined();
  });

  it('updates a running entry when its IP drifted', async () => {
    await seed({ ...baseEntry, status: 'running', ip: '192.168.1.10' });
    const provider = fakeProvider([{ name: 'a', state: 'running' }], {
      a: { name: 'a', state: 'running', networkInfo: { ipV4: '192.168.1.99' } },
    });
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changes).toEqual([
      { name: 'a', kind: 'ip-changed', ip: '192.168.1.99' },
    ]);
    const after = await readState(file);
    expect(after.sandboxes.a).toMatchObject({ ip: '192.168.1.99' });
  });

  it('does not clobber a good IP when info returns no IP', async () => {
    await seed({ ...baseEntry, status: 'running', ip: '192.168.1.10' });
    const provider = fakeProvider([{ name: 'a', state: 'running' }], {
      a: { name: 'a', state: 'running' }, // no networkInfo
    });
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changed).toBe(false);
    const after = await readState(file);
    expect(after.sandboxes.a).toMatchObject({ ip: '192.168.1.10' });
  });

  it('does not clobber a good IP when info throws', async () => {
    await seed({ ...baseEntry, status: 'running', ip: '192.168.1.10' });
    const provider = fakeProvider([{ name: 'a', state: 'running' }], {
      a: () => {
        throw new Error('orbctl boom');
      },
    });
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changed).toBe(false);
    const after = await readState(file);
    expect(after.sandboxes.a).toMatchObject({ ip: '192.168.1.10' });
  });

  it('leaves transient-status entries untouched', async () => {
    for (const status of [
      'creating',
      'starting',
      'stopping',
      'failed-init',
    ] as const) {
      await seed({ ...baseEntry, name: status, status, ip: null });
    }
    // Provider reports every VM as running — a divergence reconcile must ignore.
    const provider = fakeProvider([
      { name: 'creating', state: 'running' },
      { name: 'starting', state: 'running' },
      { name: 'stopping', state: 'running' },
      { name: 'failed-init', state: 'running' },
    ]);
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changed).toBe(false);
    expect(provider.infoVM).not.toHaveBeenCalled();
  });

  it('never adds entries for VMs not in the registry', async () => {
    await seed({ ...baseEntry, status: 'running', ip: '192.168.1.10' });
    const provider = fakeProvider(
      [
        { name: 'a', state: 'running' },
        { name: 'orbstack-builtin', state: 'running' },
        { name: 'someone-elses-vm', state: 'running' },
      ],
      {
        a: {
          name: 'a',
          state: 'running',
          networkInfo: { ipV4: '192.168.1.10' },
        },
      },
    );
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changed).toBe(false);
    const after = await readState(file);
    expect(Object.keys(after.sandboxes)).toEqual(['a']);
  });

  it('returns changed:false and skips info when nothing diverges', async () => {
    await seed({ ...baseEntry, status: 'stopped', ip: null });
    const provider = fakeProvider([{ name: 'a', state: 'stopped' }]);
    const result = await reconcileRegistry({ provider, stateFilePath: file });

    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
    expect(provider.infoVM).not.toHaveBeenCalled();
  });
});

describe('formatReconcileSummary', () => {
  it('returns null when there are no changes', () => {
    expect(formatReconcileSummary([])).toBeNull();
  });

  it('renders one line for mixed changes', () => {
    const line = formatReconcileSummary([
      { name: 'foo', kind: 'stopped' },
      { name: 'bar', kind: 'started', ip: '10.0.0.2' },
      { name: 'baz', kind: 'vanished' },
      { name: 'qux', kind: 'ip-changed', ip: '10.0.0.9' },
    ]);
    expect(line).toBe(
      'reconciled: foo running→stopped, bar stopped→running (10.0.0.2), baz vanished (removed), qux ip→10.0.0.9',
    );
  });
});
