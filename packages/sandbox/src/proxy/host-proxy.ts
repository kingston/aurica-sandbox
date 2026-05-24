import { getLocal } from 'mockttp';
import type { CompletedRequest, Mockttp } from 'mockttp';

import type { ProxyPolicy } from '#src/config/index.js';
import { logger } from '#src/logger.js';

import { ensureCA } from './ca.js';
import { applyPolicies, matchDomain } from './substitution.js';
import type { SubstitutionResolver } from './substitution.js';

interface SandboxRegistration {
  /**
   * Client IP this registration's rules apply to. A request whose
   * `remoteIpAddress` matches `sourceIp` exactly is governed by this
   * registration's `domains` + `policies`. `null` disables the registration
   * (every request from any IP falls through to the 403 sweep) — used when a
   * sandbox's IP allocation hasn't completed.
   */
  sourceIp: string | null;
  domains: readonly string[];
  policies: readonly ProxyPolicy[];
}

/**
 * Per-request verbose log payload emitted from `beforeRequest`. Surfaces the
 * details that aren't visible on mockttp's own `response` / `abort` events:
 * which policy matched (if any), the outcome, the rewrite target when
 * applicable, and a redacted list of mutations actually applied to the
 * outgoing request.
 *
 * Emitted before the request leaves the proxy; the matching `response` line
 * follows once the upstream replies, so a single request produces a verbose
 * "decision" line and then a "result" line.
 */
export interface VerboseRequestLog {
  method: string;
  host: string;
  path: string;
  remoteIp: string;
  matchedPolicyId?: string;
  outcome: 'pass' | 'block' | 'rewrite';
  blockedBy?: string;
  rewriteUrl?: string;
  mutations: {
    kind: 'set-header' | 'remove-header' | 'replace-header';
    header: string;
    value?: string;
    redacted?: boolean;
  }[];
}

/**
 * Logged when a request is denied because its host wasn't on any matching
 * sandbox's allowlist (the `forUnmatchedRequest` sweep). Visible only when
 * `verbose` is set; without it, only the eventual 403 response shows up via
 * the normal response logger.
 */
export interface VerboseDenialLog {
  method: string;
  host: string;
  path: string;
  remoteIp: string;
  reason: 'allowlist';
}

export type VerboseLogger = (
  event:
    | ({ type: 'decision' } & VerboseRequestLog)
    | ({ type: 'denial' } & VerboseDenialLog),
) => void;

export interface HostProxyOptions {
  resolver: SubstitutionResolver;
  port?: number;
  /**
   * Optional sink for verbose, per-request decision logs. When supplied,
   * the proxy emits a `decision` event from `beforeRequest` for every
   * allowlisted request (carrying matched policy id, outcome, and applied
   * mutations) and a `denial` event for every request rejected by the
   * allowlist sweep. Leave undefined to disable verbose logging.
   */
  verboseLogger?: VerboseLogger;
}

/**
 * Forward HTTP/HTTPS proxy with credential substitution and a per-host
 * allowlist, backed by mockttp.
 *
 * Public surface is intentionally unchanged from the previous hand-rolled
 * implementation so `proxy/process.ts` doesn't need rewiring.
 */
/**
 * Callback that re-attaches event listeners to the underlying mockttp server
 * after each rule rebuild. Mockttp's `reset()` clears event subscriptions
 * along with rules, so consumers must re-subscribe on every rebuild or they
 * will silently stop receiving `request` / `abort` / `tls-client-error`
 * events after the first reload.
 */
export type EventSubscriber = (server: Mockttp) => Promise<void>;

export class HostProxy {
  private readonly server: Mockttp;
  private readonly resolver: SubstitutionResolver;
  private readonly registrations = new Map<string, SandboxRegistration>();
  private readonly preferredPort: number;
  private readonly verboseLogger: VerboseLogger | undefined;
  private listenAddress?: { host: string; port: number };
  private eventSubscriber?: EventSubscriber;

  private constructor(server: Mockttp, options: HostProxyOptions) {
    this.server = server;
    this.resolver = options.resolver;
    this.preferredPort = options.port ?? 0;
    this.verboseLogger = options.verboseLogger;
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
   * Register a function that re-attaches event listeners to the underlying
   * mockttp server. Invoked once immediately and again after every rule
   * rebuild, because mockttp's `reset()` (which we call to swap rules)
   * also clears event subscriptions.
   *
   * Replaces any previously-registered subscriber.
   */
  async setEventSubscriber(subscriber: EventSubscriber): Promise<void> {
    this.eventSubscriber = subscriber;
    await subscriber(this.server);
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

  private policiesFor(remoteIp: string): ProxyPolicy[] {
    return this.registrationsForIp(remoteIp).flatMap((reg) => [
      ...reg.policies,
    ]);
  }

  private isAllowedFor(host: string, remoteIp: string): boolean {
    return this.registrationsForIp(remoteIp).some((reg) =>
      reg.domains.some((pattern) => matchDomain(pattern, host)),
    );
  }

  private async rebuildRules(): Promise<void> {
    this.server.reset();

    // Allowed hosts (scoped to the requesting sandbox's IP): pass through,
    // running policies to mutate headers or short-circuit with 403 when a
    // matching policy's action is `block`.
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
          const result = await applyPolicies(
            this.policiesFor(remoteIp),
            parts.host,
            parts.path,
            parts.method,
            headers,
            this.resolver,
            parts.pathWithQuery,
          );
          if (this.verboseLogger) {
            const decision: { type: 'decision' } & VerboseRequestLog = {
              type: 'decision',
              method: parts.method,
              host: parts.host,
              path: parts.pathWithQuery,
              remoteIp,
              outcome: result.outcome,
              mutations: result.appliedMutations,
            };
            if (result.matchedPolicyId !== undefined) {
              decision.matchedPolicyId = result.matchedPolicyId;
            }
            if (result.outcome === 'block') {
              decision.blockedBy = result.blockedBy;
            }
            if (result.outcome === 'rewrite') {
              decision.rewriteUrl = result.url;
            }
            this.verboseLogger(decision);
          }
          if (result.outcome === 'block') {
            return {
              response: {
                statusCode: 403,
                statusMessage: 'Forbidden',
                headers: { 'content-type': 'text/plain' },
                body: `aurica-sandbox: blocked by policy ${result.blockedBy}\n`,
              },
            };
          }
          if (result.outcome === 'rewrite') {
            // Strip the guest's Host header so mockttp derives a fresh
            // one from the rewritten URL. Per its docs, passing a
            // headers object with `host` set wins over the URL — which
            // would route us to the synthetic guest hostname instead of
            // the loopback target and produce ENOTFOUND. Also inject
            // X-Forwarded-For so the rewritten target can identify the
            // originating sandbox by IP (the loopback hop erases
            // `req.remoteIpAddress`), stripping any guest-supplied
            // case-variant first so it isn't guest-controllable.
            let headers = stripHeader(result.headers, 'host');
            headers = stripHeader(headers, 'x-forwarded-for');
            headers['X-Forwarded-For'] = remoteIp;
            return { url: result.url, headers };
          }
          return { headers: result.headers };
        },
      });

    // Sweep: anything that didn't match the allowlist gets 403. Uses
    // `thenCallback` (instead of `thenReply`) so verbose mode can surface
    // each denial with method+host+IP — `thenReply` would hide the request
    // details from us and only the response-event line would survive.
    await this.server.forUnmatchedRequest().thenCallback((req) => {
      if (this.verboseLogger) {
        const parts = hostAndPathFromRequest(req);
        const remoteIp = normalizeRemoteIp(req.remoteIpAddress);
        if (parts !== null && remoteIp !== null) {
          this.verboseLogger({
            type: 'denial',
            method: parts.method,
            host: parts.host,
            path: parts.pathWithQuery,
            remoteIp,
            reason: 'allowlist',
          });
        }
      }
      return {
        statusCode: 403,
        statusMessage: 'Forbidden',
        headers: { 'content-type': 'text/plain' },
        body: 'aurica-sandbox: domain not in allowlist\n',
      };
    });

    // Mockttp's reset() above also tore down any event listeners; re-attach
    // them now so log streams keep working across reloads.
    if (this.eventSubscriber) {
      await this.eventSubscriber(this.server);
    }
  }
}

function hostAndPathFromRequest(req: CompletedRequest): {
  host: string;
  path: string;
  pathWithQuery: string;
  method: string;
} | null {
  try {
    const url = new URL(req.url);
    return {
      host: url.hostname.toLowerCase(),
      // Path is case-preserving — github paths rely on this. Includes leading
      // slash and any query string-stripped path; matcher prefix evaluation
      // is segment-boundary aware (see substitution.ts).
      path: url.pathname,
      // `pathWithQuery` is what `rewrite-url` targets substitute into the
      // `{path}` template; preserves the original query string so the
      // upstream sees the same path the guest requested.
      pathWithQuery: `${url.pathname}${url.search}`,
      method: req.method,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.debug(
      `host-proxy: dropping request with unparseable URL ${JSON.stringify(req.url)}: ${reason}`,
    );
    return null;
  }
}

/**
 * Return a shallow clone of `headers` with every case-variant of `name`
 * removed. Used before setting a controlled header so a guest-supplied
 * value can't shadow it under a different casing.
 */
function stripHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): Record<string, string | string[] | undefined> {
  const target = name.toLowerCase();
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Strip the IPv4-mapped IPv6 prefix so a v4 client connecting to a dual-stack
 * proxy compares equal to its plain v4 form. Mockttp listens on `::` by
 * default, which surfaces incoming v4 connections as `::ffff:x.x.x.x`.
 */
export function normalizeRemoteIp(remoteIp: string | undefined): string | null {
  if (remoteIp === undefined) return null;
  if (remoteIp.startsWith('::ffff:')) return remoteIp.slice('::ffff:'.length);
  return remoteIp;
}
