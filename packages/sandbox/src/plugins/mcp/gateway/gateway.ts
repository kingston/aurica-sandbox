import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { logger } from '#src/logger.js';
import type { SandboxEntry } from '#src/state/index.js';
import { errorMessage } from '#src/utils/error-message.js';

import type { McpForwarder } from './forwarder.js';
import { pickHeader } from './http-utils.js';

/**
 * Per-sandbox-per-server entry. Captures both the routing key (server
 * name) and the per-sandbox tool ACL surfaced to the forwarder's
 * `tools/list` filter. `tools: undefined` means "all tools" (the bare
 * string form in project config); `tools: []` means "no tools".
 */
export interface TenantServerEntry {
  name: string;
  tools: readonly string[] | undefined;
}

/**
 * Per-sandbox tenant entry. Built from a `SandboxEntry` plus the sandbox's
 * `.aurica/sandbox.json` `plugins.mcp.servers` list, but the gateway
 * doesn't reach back into config itself — its consumer (the sidecar
 * factory) is responsible for assembling and refreshing the table.
 *
 * `bearer` is the deterministic per-sandbox placeholder the MCP plugin
 * also wrote into the guest's `~/.claude.json` as the `Authorization`
 * value — derived from the framework's
 * `makeGeneratePlaceholder('mcp', authSecret)('bearer')`. The guest
 * never sees the sandbox's raw `authSecret`.
 */
export interface TenantEntry {
  name: string;
  bearer: string;
  /**
   * Originating sandbox IP. Compared against the `X-Forwarded-For`
   * header the host proxy stamps on every rewrite, so a bearer leaked
   * between sandboxes can't be replayed from a different source.
   */
  sourceIp: string;
  /**
   * Servers this sandbox may reach, with per-server tool ACL.
   * `enabledServers` (below) is derived from this for fast path-routing
   * checks during `identify`.
   */
  servers: readonly TenantServerEntry[];
  enabledServers: readonly string[];
}

/**
 * Result of identifying a request's tenant. Returned by
 * {@link McpGateway.identify} so handlers can react to specific failure
 * modes (bad bearer vs. unknown server) instead of being presented with
 * a single "denied" boolean.
 *
 * The gateway binds loopback-only and is fronted by the host proxy, so
 * the only path to it is via a `rewrite-url` policy. The proxy stamps
 * the originating sandbox IP into `X-Forwarded-For` on that rewrite;
 * `identify` cross-checks it against the tenant's `sourceIp` as
 * defense-in-depth against a proxy misconfiguration that would let one
 * sandbox's bearer leak to another's network namespace.
 */
export type IdentifyFailureReason =
  | 'bad-path'
  | 'no-bearer'
  | 'unauthenticated'
  | 'server-not-enabled'
  | 'source-ip-mismatch';

export type IdentifyResult =
  | { ok: true; tenant: TenantEntry; server: string }
  | { ok: false; reason: IdentifyFailureReason };

const PATH_PATTERN = /^\/(?<server>[a-z0-9][a-z0-9-]*)\/mcp(?:\/.*)?$/i;

export interface McpGatewayOptions {
  /**
   * Optional explicit port. When omitted, the OS picks a free port and
   * the bound address is surfaced via {@link McpGateway.address}.
   */
  port?: number;
  /**
   * Optional host. Defaults to `127.0.0.1`; tests may override. Production
   * callers should leave this unset — the gateway is loopback-only by
   * design and reached via the host proxy's URL-rewrite policy.
   */
  host?: string;
  /**
   * Optional MCP forwarder. When provided, identified requests are
   * handed to it for session management + upstream MCP dispatch; when
   * omitted (or `null`), `#dispatch` short-circuits with a 503 so a
   * unit test can exercise just the identify path without standing up
   * the SDK plumbing.
   */
  forwarder?: McpForwarder | null;
}

/**
 * Loopback HTTP server hosting the per-sandbox MCP gateway.
 *
 * In Phase 1 the gateway maintains its tenant table and rejects
 * un-routable requests with structured errors. Actual upstream MCP
 * proxying (per-upstream `Client` cache, JSON-RPC relay over Streamable
 * HTTP) is wired up in Phase 2 once the guest-side path-rewrite policy
 * is in place — until then nothing routes requests here, so a stub
 * handler is sufficient.
 *
 * Binding is loopback-only because the gateway is reached exclusively
 * through the existing HTTPS proxy's URL-rewrite policy. Exposing it on
 * a routable interface would create a second trust boundary; keeping it
 * on `127.0.0.1` keeps the proxy the single chokepoint.
 */
export class McpGateway {
  readonly #server: Server;
  readonly #host: string;
  readonly #requestedPort: number | undefined;
  readonly #forwarder: McpForwarder | null;
  #boundPort: number | null = null;
  #tenants = new Map<string, TenantEntry>();

  constructor(opts: McpGatewayOptions = {}) {
    this.#host = opts.host ?? '127.0.0.1';
    this.#requestedPort = opts.port;
    this.#forwarder = opts.forwarder ?? null;
    this.#server = createServer((req, res) => {
      // Wrap in a try/catch so an exception in identify/dispatch never
      // bubbles out as an unhandled error event on the server.
      try {
        // Parse via URL so the query string is stripped before regex
        // matching — Streamable HTTP clients commonly append session
        // params (e.g. `?sessionId=...`) that would otherwise break the
        // `$`-anchored path pattern.
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        void this.#dispatch(pathname, req, res);
      } catch (err) {
        logger.error(`mcp-gateway: unhandled error: ${errorMessage(err)}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    });
  }

  /**
   * Begin listening. Resolves to the bound address. Idempotent: a second
   * call without a preceding `close()` rejects.
   */
  async listen(): Promise<{ host: string; port: number }> {
    if (this.#boundPort !== null) {
      throw new Error('mcp-gateway: already listening');
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.#server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.#server.off('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(this.#requestedPort ?? 0, this.#host);
    });
    const addr = this.#server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('mcp-gateway: unexpected address shape after listen');
    }
    this.#boundPort = addr.port;
    return { host: this.#host, port: addr.port };
  }

  /** Close the server. No-op when not listening. */
  async close(): Promise<void> {
    if (this.#boundPort === null) return;
    this.#boundPort = null;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Bound `{ host, port }`, or `null` when the server isn't listening.
   */
  address(): { host: string; port: number } | null {
    if (this.#boundPort === null) return null;
    return { host: this.#host, port: this.#boundPort };
  }

  /**
   * Replace the entire tenant table. Called by the sidecar on every
   * sandbox-registration change so the gateway sees a consistent view.
   * The table is keyed by sandbox name; lookups happen by source IP.
   */
  setTenants(entries: readonly TenantEntry[]): void {
    const next = new Map<string, TenantEntry>();
    for (const entry of entries) next.set(entry.name, entry);
    this.#tenants = next;
  }

  /**
   * Build tenant entries from a snapshot of {@link SandboxEntry} plus two
   * resolvers: one returns each sandbox's enabled server list, the other
   * returns the per-sandbox `bearer` placeholder. Centralized here so
   * tests and the sidecar share one definition; the resolvers let the
   * sidecar derive these values without the gateway pulling in config
   * loaders or the framework's placeholder hasher.
   */
  static buildTenants(
    sandboxes: readonly SandboxEntry[],
    serversFor: (sandbox: SandboxEntry) => readonly TenantServerEntry[],
    bearerFor: (sandbox: SandboxEntry) => string,
  ): TenantEntry[] {
    const out: TenantEntry[] = [];
    for (const sandbox of sandboxes) {
      // Sandboxes still being created (no IP yet) can't participate.
      if (sandbox.ip === null) continue;
      const servers = serversFor(sandbox);
      out.push({
        name: sandbox.name,
        bearer: bearerFor(sandbox),
        sourceIp: sandbox.ip,
        servers,
        enabledServers: servers.map((s) => s.name),
      });
    }
    return out;
  }

  /**
   * Match an incoming `(path, bearerHeader)` against the tenant table.
   * Returns the resolved tenant + server name on success, or a structured
   * failure reason. Exposed so the handler stays focused on response
   * shaping; tests exercise this directly.
   */
  identify(
    pathname: string,
    bearerHeader: string | undefined,
    forwardedFor: string | undefined,
  ): IdentifyResult {
    const m = PATH_PATTERN.exec(pathname);
    if (!m?.groups?.server) return { ok: false, reason: 'bad-path' };
    const server = m.groups.server;

    const presented = parseBearer(bearerHeader);
    if (presented === null) return { ok: false, reason: 'no-bearer' };

    let tenant: TenantEntry | undefined;
    for (const entry of this.#tenants.values()) {
      if (entry.bearer === presented) {
        tenant = entry;
        break;
      }
    }
    if (tenant === undefined) return { ok: false, reason: 'unauthenticated' };
    if (!tenant.enabledServers.includes(server)) {
      return { ok: false, reason: 'server-not-enabled' };
    }
    // The host proxy stamps the originating sandbox IP into
    // `X-Forwarded-For` on every rewrite — its absence (or a value that
    // doesn't match the bearer-resolved tenant) means the request
    // didn't transit the proxy or transited it on behalf of a different
    // sandbox. Either way: refuse it.
    const claimedIp = parseForwardedFor(forwardedFor);
    if (claimedIp === null || claimedIp !== tenant.sourceIp) {
      return { ok: false, reason: 'source-ip-mismatch' };
    }
    return { ok: true, tenant, server };
  }

  async #dispatch(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const id = this.identify(
      pathname,
      pickHeader(req.headers.authorization),
      pickHeader(req.headers['x-forwarded-for']),
    );
    if (!id.ok) {
      respondError(res, id.reason);
      return;
    }
    if (this.#forwarder === null) {
      // No forwarder attached (e.g. a unit test exercising identify
      // only). Surface a structured error rather than silently hanging.
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'forwarder_not_configured',
          server: id.server,
          sandbox: id.tenant.name,
        }),
      );
      return;
    }
    // Resolve the tenant's per-server tool ACL. The list-routing check
    // above ensured the server is enabled; this lookup just fetches the
    // tool allowlist for the forwarder. A missing entry here means
    // someone removed it between identify() and dispatch — treat as
    // server-not-enabled.
    const tenantServer = id.tenant.servers.find((s) => s.name === id.server);
    if (tenantServer === undefined) {
      respondError(res, 'server-not-enabled');
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      logger.warn(
        `mcp-gateway: invalid request body for ${id.server}/${id.tenant.name}: ${errorMessage(
          err,
        )}`,
      );
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_body' }));
      return;
    }
    try {
      await this.#forwarder.forward(
        {
          tenantName: id.tenant.name,
          serverName: id.server,
          enabledTools: tenantServer.tools,
        },
        req,
        res,
        body,
      );
    } catch (err) {
      logger.error(
        `mcp-gateway: forwarder for ${id.server}/${id.tenant.name} threw: ${errorMessage(
          err,
        )}`,
      );
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream_unavailable' }));
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}

/**
 * Drain the request body to a string and parse as JSON. Returns
 * `undefined` for a GET / empty-body request — the SDK's
 * `StreamableHTTPServerTransport.handleRequest` accepts `undefined`
 * for those.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? null;
}

/**
 * Extract the originating IP from an `X-Forwarded-For` header. The
 * host proxy emits a single-value header (no upstream chain), but we
 * still parse the comma-separated form defensively and take the first
 * entry — that's the leftmost (originating) client per the de-facto
 * standard.
 */
function parseForwardedFor(header: string | undefined): string | null {
  if (!header) return null;
  const first = header.split(',')[0]?.trim();
  if (first === undefined || first === '') return null;
  return first;
}

const ERROR_STATUS: Record<IdentifyFailureReason, number> = {
  'bad-path': 404,
  'no-bearer': 401,
  unauthenticated: 401,
  'server-not-enabled': 403,
  'source-ip-mismatch': 401,
};

function respondError(
  res: ServerResponse,
  reason: IdentifyFailureReason,
): void {
  res.writeHead(ERROR_STATUS[reason], { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: reason }));
}
