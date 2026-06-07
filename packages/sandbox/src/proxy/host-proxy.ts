import { getLocal } from 'mockttp';
import type { CompletedRequest, Mockttp } from 'mockttp';

import type {
  ProxyPolicy,
  ResponseCache,
  ResponseInterceptor,
} from '#src/config/index.js';
import { logger } from '#src/logger.js';

import { ensureCA } from './ca.js';
import {
  applyOAuthTokenInterceptor,
  tryShortCircuitRefresh,
} from './oauth/intercept.js';
import { readCache, writeCache } from './response-cache.js';
import { applyPolicies, matchDomain } from './substitution.js';
import type {
  AppliedMutation,
  EvaluationOutcome,
  SubstitutionResolver,
} from './substitution.js';

interface SandboxRegistration {
  /**
   * Client IP this registration's rules apply to. A request whose
   * `remoteIpAddress` matches `sourceIp` exactly is governed by this
   * registration's `domains` + `policies`. `null` disables the registration
   * (no IP matches it, so requests fall through to the unregistered-IP 403) —
   * used when a sandbox's IP allocation hasn't completed.
   */
  sourceIp: string | null;
  domains: readonly string[];
  policies: readonly ProxyPolicy[];
  /**
   * Domains the user explicitly listed under `proxy.domains` (excluding
   * plugin-contributed domains). Logging-only — surfaced in the reload banner;
   * `domains` remains the source of truth for allowlist enforcement. Defaults
   * to empty when omitted.
   */
  configDomains?: readonly string[];
  /**
   * Names of the plugins the project opted into. Logging-only — surfaced in
   * the reload banner. Defaults to empty when omitted.
   */
  enabledPlugins?: readonly string[];
}

/**
 * Per-request context for verbose log payloads — the request-side fields
 * that aren't on mockttp's `response` / `abort` events and so wouldn't
 * survive into the post-flight log line. The outcome-side fields (which
 * policy matched, applied mutations, rewrite target) ride along via the
 * discriminated union in {@link VerboseDecisionEvent}.
 */
interface VerboseRequestContext {
  /** mockttp's per-request id, used to pair this line with its response line. */
  id: string;
  method: string;
  host: string;
  path: string;
  remoteIp: string;
}

/**
 * Distributive `Omit` — preserves the discriminated-union shape when stripping
 * a member. Plain `Omit<T, K>` collapses the union into a single intersection
 * whose discriminants no longer narrow, which is exactly what we don't want
 * when the formatter discriminates on `outcome`.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Decision event emitted before the request leaves the proxy: request
 * context + the {@link EvaluationOutcome} (minus its `headers`, which carry
 * resolved secrets and have no business in a log payload). The matching
 * `response` line follows once the upstream replies, so a single request
 * produces a verbose "decision" line and then a "result" line.
 *
 * Composed from `EvaluationOutcome` rather than re-flattened so adding a new
 * `outcome` variant surfaces here as a type error rather than silently
 * dropping the new discriminant data.
 */
export type VerboseDecisionEvent = VerboseRequestContext &
  DistributiveOmit<EvaluationOutcome, 'headers'>;

/** Mutation summary as it appears on a verbose decision event. */
export type { AppliedMutation };

/**
 * Logged when a request is denied. `allowlist` means a registered sandbox IP
 * made a request whose host isn't on its allowlist and no policy matched.
 * `unregistered-ip` means the source IP isn't registered to any sandbox at
 * all. Visible only when `verbose` is set.
 */
export interface VerboseDenialLog {
  /** mockttp's per-request id, used to pair this line with its response line. */
  id: string;
  method: string;
  host: string;
  path: string;
  remoteIp: string;
  reason: 'allowlist' | 'unregistered-ip';
}

/**
 * Late-arriving mutations that should be folded into a request's verbose
 * block under the existing `mutations:` section. Emitted from places that
 * run after the initial decision event was buffered — e.g. OAuth
 * intercept handlers firing in `beforeRequest` (refresh short-circuit) or
 * `beforeResponse` (authorization_code capture). The `process.ts` side
 * appends these onto the buffered decision's `appliedMutations` array;
 * the per-request render then includes them automatically.
 */
export interface VerboseMutationsAppend {
  id: string;
  mutations: readonly AppliedMutation[];
}

export type VerboseLogger = (
  event:
    | ({ type: 'decision' } & VerboseDecisionEvent)
    | ({ type: 'denial' } & VerboseDenialLog)
    | ({ type: 'mutations-append' } & VerboseMutationsAppend),
) => void;

export interface HostProxyOptions {
  resolver: SubstitutionResolver;
  port?: number;
  /**
   * Optional sink for verbose, per-request decision logs. When supplied,
   * the proxy emits a `decision` event from `beforeRequest` for every
   * allowlisted request (carrying matched policy id, outcome, and applied
   * mutations) and a `denial` event for every request rejected by the
   * allowlist or from an unregistered IP. Leave undefined to disable verbose
   * logging.
   */
  verboseLogger?: VerboseLogger;
  /**
   * Optional hook invoked when a request arrives from an IP not registered to
   * any sandbox. The proxy awaits it (bounded by an internal timeout) before
   * re-checking the registration map, giving the hook a chance to reconcile
   * the registry and `register` the now-known sandbox so the request can pass
   * through instead of being denied. Must resolve once registrations are
   * up to date. Errors and timeouts are swallowed — the request falls back to
   * a 403. Never called for already-registered IPs (the hot path).
   */
  onUnregisteredRequest?: (remoteIp: string) => Promise<void>;
}

/**
 * Max time the proxy waits on {@link HostProxyOptions.onUnregisteredRequest}
 * before falling back to a 403. Bounds how long a wedged reconcile can hold a
 * client socket open.
 */
const UNREGISTERED_RECONCILE_TIMEOUT_MS = 2500;

/**
 * Forward HTTP/HTTPS proxy with credential substitution and a per-host
 * allowlist, backed by mockttp. A single passthrough rule, installed once at
 * `listen()`, reads the registration map live per request — so
 * register/unregister take effect on the next request with no rule rebuild.
 */
/**
 * Callback that attaches event listeners to the underlying mockttp server.
 * Invoked once when registered (and the rules are built once at `listen()`,
 * which calls `reset()` and clears any prior subscriptions), so a consumer
 * subscribes here to receive `request` / `abort` / `tls-client-error` events.
 */
export type EventSubscriber = (server: Mockttp) => Promise<void>;

export class HostProxy {
  private readonly server: Mockttp;
  private readonly resolver: SubstitutionResolver;
  private readonly registrations = new Map<string, SandboxRegistration>();
  private readonly preferredPort: number;
  private readonly verboseLogger: VerboseLogger | undefined;
  private readonly onUnregisteredRequest:
    | ((remoteIp: string) => Promise<void>)
    | undefined;
  private listenAddress?: { host: string; port: number };
  private eventSubscriber?: EventSubscriber;

  private constructor(server: Mockttp, options: HostProxyOptions) {
    this.server = server;
    this.resolver = options.resolver;
    this.preferredPort = options.port ?? 0;
    this.verboseLogger = options.verboseLogger;
    this.onUnregisteredRequest = options.onUnregisteredRequest;
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
   * Add or replace a sandbox's allowlist + actions. Takes effect on the next
   * request — the single rule reads the registration map live.
   */
  register(name: string, registration: SandboxRegistration): void {
    this.registrations.set(name, registration);
  }

  /** Remove a sandbox's registration. Takes effect on the next request. */
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

  address(): { host: string; port: number } | undefined {
    return this.listenAddress;
  }

  /**
   * Per-sandbox snapshot of the current registration set, intended for logging.
   * Returns one entry per registered name with its `sourceIp` (nullable while
   * the VM's IP is still being allocated) and the domain patterns currently
   * allowlisted for that sandbox.
   */
  summary(): {
    name: string;
    sourceIp: string | null;
    configDomains: string[];
    enabledPlugins: string[];
  }[] {
    return [...this.registrations.entries()].map(([name, reg]) => ({
      name,
      sourceIp: reg.sourceIp,
      configDomains: [...(reg.configDomains ?? [])],
      enabledPlugins: [...(reg.enabledPlugins ?? [])],
    }));
  }

  /**
   * Register a function that attaches event listeners to the underlying
   * mockttp server. Invoked once immediately; the listeners persist for the
   * proxy's lifetime since rules are built once at `listen()` and never rebuilt.
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

  /**
   * Give `onUnregisteredRequest` a bounded chance to reconcile and register the
   * sandbox behind an unknown IP. Returns once the hook resolves or the timeout
   * elapses; errors and timeouts are swallowed (the caller re-checks the map
   * and denies if still unknown). No-op when no hook is configured.
   */
  private async tryReconcileUnregistered(remoteIp: string): Promise<void> {
    if (this.onUnregisteredRequest === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, UNREGISTERED_RECONCILE_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.onUnregisteredRequest(remoteIp), timeout]);
    } catch {
      // Swallow — caller falls back to a 403 if the IP is still unregistered.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async rebuildRules(): Promise<void> {
    this.server.reset();

    // Bridges request-side policy evaluation (which decides whether an
    // `oauth-token-response` interceptor should fire) to the response-side
    // hook (which actually rewrites the body + persists tokens). Keyed by
    // mockttp's per-request `id`; `beforeResponse` deletes its entry on
    // every reply so the map stays bounded.
    const pendingInterceptors = new Map<string, ResponseInterceptor>();

    // Bridges a request-side cache miss (an `allow` policy carried a
    // `cacheResponse` and no fresh entry existed) to the response-side hook
    // that stores the upstream 200 body. Keyed by mockttp's per-request `id`;
    // `beforeResponse` deletes its entry on every reply so the map stays
    // bounded. Stores the request URL + TTL so the response side has both.
    const pendingCaches = new Map<
      string,
      { url: string; cacheResponse: ResponseCache }
    >();

    // A single rule handles every request. The registration map (and each
    // registration's policies/allowlist) is read live here, so register/
    // unregister take effect on the next request without rebuilding rules.
    // Unregistered IPs get one chance to be reconciled (via
    // `onUnregisteredRequest`) before being denied — this is how a VM started
    // outside the CLI heals: its first request triggers a reconcile and then
    // passes through.
    await this.server.forAnyRequest().thenPassThrough({
      beforeRequest: async (req) => {
        const parts = hostAndPathFromRequest(req);
        const remoteIp = normalizeRemoteIp(req.remoteIpAddress);
        if (parts === null || remoteIp === null)
          return denyResponse('unparseable');

        if (this.registrationsForIp(remoteIp).length === 0) {
          await this.tryReconcileUnregistered(remoteIp);
          if (this.registrationsForIp(remoteIp).length === 0) {
            if (this.verboseLogger) {
              this.verboseLogger({
                type: 'denial',
                id: req.id,
                method: parts.method,
                host: parts.host,
                path: parts.pathWithQuery,
                remoteIp,
                reason: 'unregistered-ip',
              });
            }
            return denyResponse('unregistered-ip');
          }
        }

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
          { pathWithQuery: parts.pathWithQuery },
        );
        if (this.verboseLogger) {
          // Strip `headers` (carries resolved secrets) before logging;
          // every other field on `result` is safe to forward.
          const { headers: _, ...outcomeForLog } = result;
          this.verboseLogger({
            type: 'decision',
            id: req.id,
            method: parts.method,
            host: parts.host,
            path: parts.pathWithQuery,
            remoteIp,
            ...outcomeForLog,
          });
        }
        if (result.outcome === 'block') {
          return denyResponse('block', result.blockedBy);
        }
        // No policy matched — fall back to the allowlist.
        if (
          result.outcome === 'pass' &&
          result.matchedPolicyId === undefined &&
          !this.isAllowedFor(parts.host, remoteIp)
        ) {
          if (this.verboseLogger) {
            this.verboseLogger({
              type: 'denial',
              id: req.id,
              method: parts.method,
              host: parts.host,
              path: parts.pathWithQuery,
              remoteIp,
              reason: 'allowlist',
            });
          }
          return denyResponse('allowlist');
        }
        if (
          result.outcome === 'pass' &&
          result.interceptResponse !== undefined
        ) {
          // Refresh short-circuit: if the body is a `grant_type=refresh_token`
          // request, drive the refresh on the host instead of forwarding.
          // Solves a race where Claude Code fires parallel 401-triggered
          // refreshes whose rotated tokens invalidate each other upstream.
          const bodyText = await req.body.getText();
          const shortCircuit = await tryShortCircuitRefresh(
            result.interceptResponse,
            {
              url: req.url,
              headers,
              bodyText,
            },
          );
          if (shortCircuit !== null) {
            if (this.verboseLogger && shortCircuit.mutations.length > 0) {
              this.verboseLogger({
                type: 'mutations-append',
                id: req.id,
                mutations: shortCircuit.mutations,
              });
            }
            return {
              response: {
                statusCode: shortCircuit.statusCode,
                headers: shortCircuit.headers,
                body: shortCircuit.body,
              },
            };
          }
          pendingInterceptors.set(req.id, result.interceptResponse);
        }
        if (
          result.outcome === 'pass' &&
          result.cacheResponse !== undefined &&
          parts.method.toUpperCase() === 'GET'
        ) {
          // Hit: serve the stored bytes verbatim and skip upstream. `rawBody`
          // is sent without re-encoding, and the stored headers carry the
          // original `content-encoding`, so the guest decodes correctly.
          const hit = await readCache('GET', req.url);
          if (hit !== null) {
            if (this.verboseLogger) {
              this.verboseLogger({
                type: 'mutations-append',
                id: req.id,
                mutations: [
                  {
                    kind: 'cache-hit',
                    target: req.url,
                    status: 'applied',
                    reason: `${hit.body.length} bytes`,
                  },
                ],
              });
            }
            return {
              response: {
                statusCode: hit.statusCode,
                headers: hit.headers,
                rawBody: hit.body,
              },
            };
          }
          // Miss: forward upstream and store the 200 in `beforeResponse`.
          pendingCaches.set(req.id, {
            url: req.url,
            cacheResponse: result.cacheResponse,
          });
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
          return {
            url: result.url,
            headers,
          };
        }
        return {
          headers: result.headers,
        };
      },
      beforeResponse: async (res) => {
        const pendingCache = pendingCaches.get(res.id);
        if (pendingCache !== undefined) {
          pendingCaches.delete(res.id);
          // Store the raw on-the-wire bytes + headers verbatim so a later hit
          // replays them without re-encoding. `writeCache` is GET + 200 only,
          // so a non-200 miss simply isn't cached and the guest still gets it.
          if (res.statusCode === 200) {
            try {
              await writeCache('GET', pendingCache.url, {
                statusCode: res.statusCode,
                headers: res.headers,
                body: res.body.buffer,
                ttlSeconds: pendingCache.cacheResponse.ttlSeconds,
              });
              if (this.verboseLogger) {
                this.verboseLogger({
                  type: 'mutations-append',
                  id: res.id,
                  mutations: [
                    {
                      kind: 'cache-store',
                      target: pendingCache.url,
                      status: 'applied',
                      reason: `${res.body.buffer.length} bytes`,
                    },
                  ],
                });
              }
            } catch (err) {
              // A failed store must never break the response the guest gets;
              // log and forward unchanged.
              logger.warn(
                `response-cache: failed to store ${pendingCache.url}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          // The cache never rewrites the body the guest receives.
        }

        const interceptor = pendingInterceptors.get(res.id);
        if (interceptor === undefined) return undefined;
        pendingInterceptors.delete(res.id);
        // Use the decoded buffer so gzip/brotli upstreams (Anthropic
        // serves the token endpoint over a regular HTTPS gateway, but
        // can negotiate content-encoding) parse correctly.
        const decoded = await res.body.getDecodedBuffer();
        const rewritten = await applyOAuthTokenInterceptor(interceptor, {
          statusCode: res.statusCode,
          headers: res.headers,
          body: decoded,
        });
        if (rewritten === null) return undefined;
        if (this.verboseLogger && rewritten.mutations.length > 0) {
          this.verboseLogger({
            type: 'mutations-append',
            id: res.id,
            mutations: rewritten.mutations,
          });
        }
        return {
          statusCode: rewritten.statusCode,
          headers: rewritten.headers,
          body: rewritten.body,
        };
      },
    });

    // The reset() above clears any event listeners; (re-)attach them now. This
    // runs once at listen(), so a subscriber registered earlier survives it.
    if (this.eventSubscriber) {
      await this.eventSubscriber(this.server);
    }
  }
}

/** Reason a request was denied, selecting the 403 body text. */
type DenyReason = 'unparseable' | 'unregistered-ip' | 'allowlist' | 'block';

/**
 * Build the `{ response }` short-circuit a `beforeRequest` returns to deny a
 * request with a 403 and a reason-specific plain-text body.
 */
function denyResponse(
  reason: DenyReason,
  blockedBy?: string,
): {
  response: {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: string;
  };
} {
  const body = (() => {
    switch (reason) {
      case 'unparseable': {
        return 'aurica-sandbox: unparseable request\n';
      }
      case 'unregistered-ip': {
        return 'aurica-sandbox: request from unregistered IP\n';
      }
      case 'allowlist': {
        return 'aurica-sandbox: domain not in allowlist\n';
      }
      default: {
        return `aurica-sandbox: blocked by policy ${blockedBy ?? 'unknown'}\n`;
      }
    }
  })();
  return {
    response: {
      statusCode: 403,
      statusMessage: 'Forbidden',
      headers: { 'content-type': 'text/plain' },
      body,
    },
  };
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
