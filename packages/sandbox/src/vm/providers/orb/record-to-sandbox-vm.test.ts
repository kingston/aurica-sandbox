import { describe, expect, it } from 'vitest';

import { type OrbRecord, recordToSandboxVM } from './provider.js';

/** Build an `orbctl` record with a given lifecycle state. */
function record(state: OrbRecord['state'], name = 'vm'): OrbRecord {
  return {
    id: 'id-1',
    name,
    image: { distro: 'ubuntu', version: '24.04', arch: 'arm64' },
    state,
  };
}

describe('recordToSandboxVM', () => {
  it('carries the lifecycle state through (the reconcile linchpin)', () => {
    for (const state of [
      'creating',
      'starting',
      'running',
      'stopping',
      'stopped',
    ] as const) {
      expect(recordToSandboxVM(record(state))).toMatchObject({ state });
    }
  });

  it('omits networkInfo when no IPs are supplied', () => {
    const vm = recordToSandboxVM(record('running', 'a'));
    expect(vm).toEqual({ name: 'a', state: 'running' });
    expect(vm.networkInfo).toBeUndefined();
  });

  it('populates networkInfo when IPs are supplied', () => {
    const vm = recordToSandboxVM(record('running', 'a'), '10.0.0.5', 'fd00::1');
    expect(vm).toMatchObject({
      name: 'a',
      state: 'running',
      networkInfo: { ipV4: '10.0.0.5', ipV6: 'fd00::1' },
    });
  });
});
