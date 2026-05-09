import os from 'node:os';

import { logger } from '#src/logger.js';
import type { HostBridgeIp, SandboxVM } from '#src/vm/types.js';

/**
 * Override that, when set, short-circuits {@link discoverOrbBridgeIp} and
 * returns the value verbatim. Useful on first run (no VMs exist yet, so
 * subnet correlation can't infer the bridge), or when the heuristic guesses
 * the wrong interface.
 */
const OVERRIDE_ENV_VAR = 'AURICA_PROXY_BIND_IP';

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

interface InterfaceCandidate {
  name: string;
  address: string;
}

/**
 * Dependencies {@link discoverOrbBridgeIp} needs to talk to OrbStack. Passed
 * in (rather than imported from `./provider.js`) to avoid a circular import
 * — `provider.ts` is what wires this function into the `SandboxVMProvider`
 * surface.
 */
export interface OrbBridgeDeps {
  listVMs: () => Promise<SandboxVM[]>;
  infoVM: (name: string) => Promise<SandboxVM>;
}

/**
 * Resolve the host's IPv4 address on OrbStack's machine bridge.
 *
 * VMs reach this address directly over the L2 bridge with their source IP
 * preserved — unlike `host.orb.internal`, which OrbStack NAT-rewrites to
 * `127.0.0.1` and therefore collapses every VM into the same source IP from
 * the proxy's perspective, defeating per-sandbox allowlisting.
 *
 * Strategy, in order:
 *
 *  1. {@link OVERRIDE_ENV_VAR} (`AURICA_PROXY_BIND_IP`) if set — operator
 *     escape hatch and the only way to bootstrap when neither (2) nor (3)
 *     yields a result.
 *  2. Pick a running VM, derive its `/24` from `ipV4`, and return the host's
 *     IPv4 on the interface in that subnet.
 *  3. Bootstrap fallback when no running VM exists: return the first
 *     non-internal IPv4 in `192.168.0.0/16` whose interface is named
 *     `bridgeNNN`. Best-effort — Docker/Kubernetes can present similarly
 *     named interfaces — so a warning is logged when this branch fires.
 *
 * `source` on the returned value is one of `'override'`, `'vm-correlation'`,
 * or `'bootstrap-fallback'`.
 *
 * Throws if all three strategies fail.
 */
export async function discoverOrbBridgeIp(
  deps: OrbBridgeDeps,
): Promise<HostBridgeIp> {
  const override = process.env[OVERRIDE_ENV_VAR];
  if (override !== undefined && override !== '') {
    if (!IPV4_REGEX.test(override)) {
      throw new Error(
        `${OVERRIDE_ENV_VAR}=${JSON.stringify(override)} is not a valid IPv4 address`,
      );
    }
    return { ip: override, source: 'override' };
  }

  const interfaces = collectIpv4Interfaces();

  const vmIp = await firstRunningVmIpV4(deps);
  if (vmIp !== null) {
    const subnet = ipv4Slash24(vmIp);
    if (subnet !== null) {
      const match = interfaces.find(
        (iface) => ipv4Slash24(iface.address) === subnet,
      );
      if (match !== undefined) {
        return { ip: match.address, source: 'vm-correlation' };
      }
    }
  }

  const fallback = interfaces.find(
    (iface) =>
      /^bridge\d+$/.test(iface.name) && iface.address.startsWith('192.168.'),
  );
  if (fallback !== undefined) {
    logger.warn(
      `no running OrbStack VMs; guessed bridge IP ${fallback.address} on ${fallback.name}. If this is wrong, set ${OVERRIDE_ENV_VAR}.`,
    );
    return { ip: fallback.address, source: 'bootstrap-fallback' };
  }

  const detail = interfaces
    .map((iface) => `${iface.name}=${iface.address}`)
    .join(', ');
  throw new Error(
    `unable to discover OrbStack bridge IP: no running VM and no bridgeN interface in 192.168.0.0/16. Candidates: ${detail || '(none)'}. Set ${OVERRIDE_ENV_VAR} to override.`,
  );
}

async function firstRunningVmIpV4(deps: OrbBridgeDeps): Promise<string | null> {
  let names: string[];
  try {
    const vms = await deps.listVMs();
    names = vms.map((vm) => vm.name);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const info = await deps.infoVM(name);
      const ip = info.networkInfo?.ipV4;
      if (ip !== undefined && ip !== '') return ip;
    } catch {
      /* skip VMs we can't inspect */
    }
  }
  return null;
}

function collectIpv4Interfaces(): InterfaceCandidate[] {
  const out: InterfaceCandidate[] = [];
  const all = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(all)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

function ipv4Slash24(ip: string): string | null {
  if (!IPV4_REGEX.test(ip)) return null;
  const lastDot = ip.lastIndexOf('.');
  const subnet = ip.slice(0, lastDot);
  for (const octet of ip.split('.')) {
    if (Number.parseInt(octet, 10) > 255) return null;
  }
  return subnet;
}
