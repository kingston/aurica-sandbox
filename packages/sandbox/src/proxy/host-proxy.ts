import { getLocal } from 'mockttp';
import type { CompletedRequest, Mockttp } from 'mockttp';

import type { ProxyAction } from '#src/config/index.js';

import { ensureCA } from './ca.js';
import { applyActions, matchDomain } from './substitution.js';
import type { SubstitutionResolver } from './substitution.js';

interface SandboxRegistration {
  /**
   * Client IP this registration's rules apply to. A request whose
   * `remoteIpAddress` matches `sourceIp` exactly is governed by this
   * registration's `domains` + `actions`. `null` disables the registration
   * (every request from any IP falls through to the 403 sweep) — used when a
   * sandbox's IP allocation hasn't completed.
   */
  sourceIp: string | null;
  domains: readonly string[];
  actions: readonly ProxyAction[];
}

export interface HostProxyOptions {
  resolver: SubstitutionResolver;
  port?: number;
}

/**
 * Forward HTTP/HTTPS proxy with credential substitution and a per-host
 * allowlist, backed by mockttp.
 *
 * Public surface is intentionally unchanged from the previous hand-rolled
 * implementation so `proxy/process.ts` doesn't need rewiring.
 */
export class HostProxy {
  private readonly server: Mockttp;
  private readonly resolver: SubstitutionResolver;
  private readonly registrations = new Map<string, SandboxRegistration>();
  private readonly preferredPort: number;
  private listenAddress?: { host: string; port: number };

  private constructor(server: Mockttp, options: HostProxyOptions) {
    this.server = server;
    this.resolver = options.resolver;
    this.preferredPort = options.port ?? 0;
  }

  /**
   * Construct + load a CA. Async because we always need the CA on disk before
   * mockttp boots; consumers want a single `await` regardless.
   */
  static async create(options: HostProxyOptions): Promise<HostProxy> {
    const ca = await ensureCA();
    const server = getLocal({
      https: { keyPath: ca.keyPath, certPath: ca.certPath },
      // Suppress mockttp's own console output; we surface what we need via on().
      recordTraffic: false,
    });
    return new HostProxy(server, options);
  }

  /**
   * Add or replace a sandbox's allowlist + actions. Call `refresh()` after a
   * batch of register/unregister calls to apply them to the live proxy.
   */
  register(name: string, registration: SandboxRegistration): void {
    this.registrations.set(name, registration);
  }

  /** Remove a sandbox's registration. See `register` re: needing `refresh()`. */
  unregister(name: string): void {
    this.registrations.delete(name);
  }

  registeredNames(): string[] {
    return [...this.registrations.keys()];
  }

  /** Start listening on the preferred port (or any free port if 0). */
  async listen(): Promise<{ host: string; port: number }> {
    await this.server.start(this.preferredPort);
    this.listenAddress = { host: '127.0.0.1', port: this.server.port };
    await this.rebuildRules();
    return this.listenAddress;
  }

  async close(): Promise<void> {
    await this.server.stop();
  }

  /**
   * Re-derive mockttp rules from the current registration set. Call after any
   * register/unregister.
   */
  async refresh(): Promise<void> {
    if (this.listenAddress) await this.rebuildRules();
  }

  address(): { host: string; port: number } | undefined {
    return this.listenAddress;
  }

  /**
   * Per-sandbox snapshot of the current registration set, intended for logging.
   * Returns one entry per registered name with its `sourceIp` (nullable while
   * the VM's IP is still being allocated) and the domain patterns currently
   * allowlisted for that sandbox.
   */
  summary(): { name: string; sourceIp: string | null; domains: string[] }[] {
    return [...this.registrations.entries()].map(([name, reg]) => ({
      name,
      sourceIp: reg.sourceIp,
      domains: [...reg.domains],
    }));
  }

  /**
   * The mockttp instance, exposed read-only so `proxy/process.ts` can subscribe
   * to events (`request`, `abort`, `tls-client-error`).
   */
  events(): Mockttp {
    return this.server;
  }

  /**
   * Registrations whose `sourceIp` matches the given remote IP. Skips
   * registrations with `sourceIp: null` (sandbox known but IP not yet
   * allocated — those are inert until SIGHUP re-registers them).
   */
  private registrationsForIp(remoteIp: string): SandboxRegistration[] {
    return [...this.registrations.values()].filter(
      (reg) => reg.sourceIp === remoteIp,
    );
  }

  private actionsFor(remoteIp: string): ProxyAction[] {
    return this.registrationsForIp(remoteIp).flatMap((reg) => [...reg.actions]);
  }

  private isAllowedFor(host: string, remoteIp: string): boolean {
    return this.registrationsForIp(remoteIp).some((reg) =>
      reg.domains.some((pattern) => matchDomain(pattern, host)),
    );
  }

  private async rebuildRules(): Promise<void> {
    this.server.reset();

    // Allowed hosts (scoped to the requesting sandbox's IP): pass through,
    // applying credential substitution to headers.
    await this.server
      .forAnyRequest()
      .matching((req: CompletedRequest) => {
        const parts = hostAndPathFromRequest(req);
        if (parts === null) return false;
        const remoteIp = normalizeRemoteIp(req.remoteIpAddress);
        if (remoteIp === null) return false;
        return this.isAllowedFor(parts.host, remoteIp);
      })
      .thenPassThrough({
        beforeRequest: async (req) => {
          const parts = hostAndPathFromRequest(req);
          if (parts === null) return undefined;
          const remoteIp = normalizeRemoteIp(req.remoteIpAddress);
          if (remoteIp === null) return undefined;
          const headers: Record<string, string | string[] | undefined> = {
            ...req.headers,
          };
          await applyActions(
            this.actionsFor(remoteIp),
            parts.host,
            parts.path,
            headers,
            this.resolver,
          );
          return { headers };
        },
      });

    // Sweep: anything that didn't match the allowlist gets 403.
    await this.server
      .forUnmatchedRequest()
      .thenReply(
        403,
        'Forbidden',
        'aurica-sandbox: domain not in allowlist\n',
        { 'content-type': 'text/plain' },
      );
  }
}

function hostAndPathFromRequest(
  req: CompletedRequest,
): { host: string; path: string } | null {
  try {
    const url = new URL(req.url);
    return {
      host: url.hostname.toLowerCase(),
      // Path is case-preserving — github paths rely on this. Includes leading
      // slash and any query string-stripped path; pathPrefix matching is
      // startsWith on this value.
      path: url.pathname,
    };
  } catch {
    return null;
  }
}

/**
 * Strip the IPv4-mapped IPv6 prefix so a v4 client connecting to a dual-stack
 * proxy compares equal to its plain v4 form. Mockttp listens on `::` by
 * default, which surfaces incoming v4 connections as `::ffff:x.x.x.x`.
 */
function normalizeRemoteIp(remoteIp: string | undefined): string | null {
  if (remoteIp === undefined) return null;
  if (remoteIp.startsWith('::ffff:')) return remoteIp.slice('::ffff:'.length);
  return remoteIp;
}
