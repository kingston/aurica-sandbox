import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxVM } from '#src/vm/types.js';

import { discoverOrbBridgeIp, type OrbBridgeDeps } from './bridge-ip.js';

const ENV_VAR = 'AURICA_PROXY_BIND_IP';

function ifaces(
  spec: Record<string, { address: string; internal?: boolean }[]>,
): Record<string, os.NetworkInterfaceInfo[]> {
  const out: Record<string, os.NetworkInterfaceInfo[]> = {};
  for (const [name, addrs] of Object.entries(spec)) {
    out[name] = addrs.map((a) => ({
      address: a.address,
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: a.internal ?? false,
      cidr: `${a.address}/24`,
    }));
  }
  return out;
}

function deps(overrides: Partial<OrbBridgeDeps> = {}): OrbBridgeDeps {
  return {
    listVMs: () => Promise.resolve([]),
    infoVM: (name) => Promise.resolve({ name }),
    ...overrides,
  };
}

describe('discoverOrbBridgeIp', () => {
  let originalOverride: string | undefined;

  beforeEach(() => {
    originalOverride = process.env[ENV_VAR];
    Reflect.deleteProperty(process.env, ENV_VAR);
  });

  afterEach(() => {
    if (originalOverride === undefined) {
      Reflect.deleteProperty(process.env, ENV_VAR);
    } else {
      process.env[ENV_VAR] = originalOverride;
    }
    vi.restoreAllMocks();
  });

  it('returns the env var when set, without consulting OrbStack or interfaces', async () => {
    process.env[ENV_VAR] = '10.0.0.5';
    const listVMs = vi.fn<OrbBridgeDeps['listVMs']>(() =>
      Promise.reject(new Error('should not be called')),
    );

    const result = await discoverOrbBridgeIp(deps({ listVMs }));

    expect(result).toEqual({ ip: '10.0.0.5', source: 'override' });
    expect(listVMs).not.toHaveBeenCalled();
  });

  it('rejects an env var that does not parse as IPv4', async () => {
    process.env[ENV_VAR] = 'not-an-ip';
    await expect(discoverOrbBridgeIp(deps())).rejects.toThrow(
      /AURICA_PROXY_BIND_IP/,
    );
  });

  it('correlates a running VM IP with a host interface in the same /24', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(
      ifaces({
        lo0: [{ address: '127.0.0.1', internal: true }],
        en0: [{ address: '10.13.4.22' }],
        bridge100: [{ address: '192.168.139.3' }],
      }),
    );

    const result = await discoverOrbBridgeIp(
      deps({
        listVMs: () => Promise.resolve([{ name: 'main' }]),
        infoVM: () =>
          Promise.resolve({
            name: 'main',
            networkInfo: { ipV4: '192.168.139.118' },
          }),
      }),
    );
    expect(result).toEqual({ ip: '192.168.139.3', source: 'vm-correlation' });
  });

  it('skips VMs without an IPv4 and uses the next running VM', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(
      ifaces({ bridge100: [{ address: '192.168.139.3' }] }),
    );
    const infoVM = (name: string): Promise<SandboxVM> => {
      if (name === 'stopped') return Promise.resolve({ name: 'stopped' });
      return Promise.resolve({
        name: 'running',
        networkInfo: { ipV4: '192.168.139.42' },
      });
    };

    const result = await discoverOrbBridgeIp(
      deps({
        listVMs: () =>
          Promise.resolve([{ name: 'stopped' }, { name: 'running' }]),
        infoVM,
      }),
    );
    expect(result.ip).toBe('192.168.139.3');
    expect(result.source).toBe('vm-correlation');
  });

  it('falls back to bridgeN guessing when there is no running VM to correlate against', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(
      ifaces({
        lo0: [{ address: '127.0.0.1', internal: true }],
        en0: [{ address: '10.13.4.22' }],
        bridge100: [{ address: '192.168.139.3' }],
      }),
    );

    const result = await discoverOrbBridgeIp(deps());
    expect(result).toEqual({
      ip: '192.168.139.3',
      source: 'bootstrap-fallback',
    });
  });

  it('falls back when listVMs throws (e.g. orbctl not on PATH)', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(
      ifaces({ bridge42: [{ address: '192.168.200.1' }] }),
    );

    const result = await discoverOrbBridgeIp(
      deps({
        listVMs: () => Promise.reject(new Error('orbctl: command not found')),
      }),
    );
    expect(result.source).toBe('bootstrap-fallback');
    expect(result.ip).toBe('192.168.200.1');
  });

  it('throws when neither correlation nor fallback finds a candidate', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(
      ifaces({
        lo0: [{ address: '127.0.0.1', internal: true }],
        en0: [{ address: '10.13.4.22' }],
      }),
    );

    await expect(discoverOrbBridgeIp(deps())).rejects.toThrow(
      /unable to discover OrbStack bridge IP/,
    );
  });

  it('does not pick a non-bridge interface for the bootstrap fallback even if it is in 192.168/16', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(
      ifaces({
        en0: [{ address: '192.168.1.50' }],
      }),
    );

    await expect(discoverOrbBridgeIp(deps())).rejects.toThrow(
      /unable to discover OrbStack bridge IP/,
    );
  });
});
