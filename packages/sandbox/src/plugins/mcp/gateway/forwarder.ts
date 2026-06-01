import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// `Server` is the low-level MCP server; we deliberately use it (not the
// high-level `McpServer`) for direct `setRequestHandler` routing of
// `tools/list` and `tools/call`.
// eslint-disable-next-line @typescript-eslint/no-deprecated
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from '#src/logger.js';
import { errorMessage } from '#src/utils/error-message.js';

import type { CanonicalToolPolicy } from '../schema.js';
import { FileOAuthProvider } from './file-oauth-provider.js';
import { pickHeader } from './http-utils.js';
import { filterToolsForList, matchToolCall } from './policy.js';

/**
 * Per-upstream configuration the gateway needs to forward MCP traffic.
 * Discriminated by `auth.type`:
 *
 * - `oauth`: the gateway runs the SDK's `auth()` flow + caches tokens via
 *   {@link FileOAuthProvider}. `clientMetadata` must match what `mcp
 *   login` originally registered or the SDK re-registers the client on
 *   every refresh.
 * - `bearer`: the gateway resolves `tokenSource` via the configured
 *   credential cache and stamps `Authorization: Bearer <resolved>` onto
 *   every outbound MCP request. No OAuth, no `mcp login`. Right for
 *   PAT-style static credentials (GitHub PATs, internal service tokens).
 */
export type UpstreamCatalogEntry =
  | {
      url: string;
      auth: { type: 'oauth'; clientMetadata: OAuthClientMetadata };
    }
  | {
      url: string;
      auth: { type: 'bearer'; tokenSource: string };
    };

/** Map of upstream name → upstream config. See {@link UpstreamCatalogEntry}. */
export type UpstreamCatalog = ReadonlyMap<string, UpstreamCatalogEntry>;

/**
 * Subset of {@link CredentialResolver} the forwarder depends on. Lets the
 * sidecar pass in its own resolver (so PAT lookups are shared with the
 * proxy's `replace-header` resolutions) without dragging the whole
 * class into the test surface.
 */
export interface BearerTokenResolver {
  resolve(rawSource: string): Promise<string>;
}

/** Options for {@link McpForwarder}. */
export interface McpForwarderOptions {
  /**
   * Idle timeout in milliseconds after which an inactive session is
   * dropped. Clients are supposed to send DELETE on shutdown but rarely
   * do; without a sweeper, stale sessions would accumulate over the
   * proxy's lifetime.
   */
  sessionIdleMs?: number;
  /**
   * Resolver used by `bearer`-auth upstreams to expand a credential
   * source (`env:GH_PAT`, `gh-token`, …) into a token string. Required
   * when any `bearer`-auth upstream is registered; calls fail loudly
   * otherwise. The sidecar typically passes the same
   * {@link CredentialResolver} instance the host proxy uses.
   */
  bearerTokenResolver?: BearerTokenResolver;
}

/**
 * Per-session record. Each entry is bound at `initialize` time to one
 * tenant and one upstream server; thereafter the session is the trust
 * anchor — every subsequent request resolves the tenant via the
 * session, never via the bearer alone (the bearer is re-validated by
 * the gateway anyway, but the session→tenant binding stops a leaked
 * bearer from being replayed as a different tenant).
 */
interface SessionRecord {
  tenantName: string;
  serverName: string;
  policies: readonly CanonicalToolPolicy[];
  defaultAction: 'allow' | 'block';
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActive: number;
}

/**
 * Per-upstream record. One {@link Client} is shared across every
 * sandbox that uses the upstream: OAuth tokens are host-owned, so
 * sharing the client means we don't pay reconnect cost per-tenant and
 * we don't multiply the upstream's connection count.
 *
 * `connectPromise` deduplicates concurrent first-request connects;
 * `client` is non-null once the connect resolves.
 */
interface OAuthUpstreamRecord {
  authType: 'oauth';
  url: string;
  clientMetadata: OAuthClientMetadata;
  provider: FileOAuthProvider;
  client: Client | null;
  connectPromise: Promise<void> | null;
}

interface BearerUpstreamRecord {
  authType: 'bearer';
  url: string;
  tokenSource: string;
  client: Client | null;
  connectPromise: Promise<void> | null;
}

type UpstreamRecord = OAuthUpstreamRecord | BearerUpstreamRecord;

/**
 * Authenticated request context the gateway hands to
 * {@link McpForwarder.forward}. Pre-resolved so the forwarder never
 * touches the auth/routing tables — the gateway is the single
 * chokepoint for both.
 */
export interface ForwardContext {
  tenantName: string;
  serverName: string;
  policies: readonly CanonicalToolPolicy[];
  defaultAction: 'allow' | 'block';
}

/**
 * Specific error returned by tools/list and tools/call handlers when
 * upstream credentials are missing or refresh failed. Surfaces to the
 * guest as a JSON-RPC error result rather than a transport-level 401,
 * so MCP-aware clients can present it as a tool error.
 */
class UpstreamLoginRequiredError extends Error {
  readonly server: string;
  constructor(server: string, detail: string) {
    super(`${server}: ${detail}`);
    this.name = 'UpstreamLoginRequiredError';
    this.server = server;
  }
}

const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * MCP-aware forwarder. Terminates Streamable HTTP from the guest with a
 * per-session {@link Server} + {@link StreamableHTTPServerTransport}
 * pair, and proxies `tools/list` / `tools/call` to a shared per-upstream
 * {@link Client}.
 *
 * Compared to the byte-level HTTP relay it replaces, this approach
 * decouples the guest↔gateway session from the gateway↔upstream
 * session — useful because some upstreams (Linear) are themselves
 * stateful and issue their own session IDs that don't survive
 * stateless replay.
 *
 * MVP scope: tools-only. `capabilities` advertises just `{ tools: {} }`
 * so well-behaved clients don't probe `resources/*` or `prompts/*`. The
 * underlying {@link Server} returns "Method not found" for anything we
 * haven't registered.
 */
export class McpForwarder {
  #catalog: UpstreamCatalog = new Map();
  readonly #upstreams = new Map<string, UpstreamRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #sessionIdleMs: number;
  readonly #bearerTokenResolver: BearerTokenResolver | undefined;
  #sweeper: NodeJS.Timeout | null = null;

  constructor(opts: McpForwarderOptions = {}) {
    this.#sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    this.#bearerTokenResolver = opts.bearerTokenResolver;
  }

  /**
   * Replace the upstream catalog. Sessions for upstreams removed from
   * the catalog are closed; their `Client`s are dropped so re-adding
   * the upstream reconnects from a clean slate. Sessions for unchanged
   * upstreams stay live.
   */
  setCatalog(catalog: UpstreamCatalog): void {
    this.#catalog = catalog;
    const toDelete: string[] = [];
    for (const [name, record] of this.#upstreams) {
      if (!catalog.has(name)) {
        toDelete.push(name);
        // Best-effort close; we don't await it here because setCatalog
        // is called synchronously from a sandbox-snapshot subscriber.
        record.client?.close().catch((err: unknown) => {
          logger.debug(`mcp-forwarder: close ${name}: ${errorMessage(err)}`);
        });
      }
    }
    for (const name of toDelete) this.#upstreams.delete(name);
    this.#dropSessionsWhere(
      (s) => !catalog.has(s.serverName),
      'upstream removed from catalog',
    );
  }

  /**
   * Forward an authenticated guest request. The gateway has already
   * checked the bearer and source IP and matched the path's server
   * segment against the tenant's enabled list; this method only owns
   * session lookup, session→tenant binding verification, and the actual
   * Streamable HTTP transport handoff.
   */
  async forward(
    ctx: ForwardContext,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    this.#ensureSweeperRunning();
    const sessionHeader = pickHeader(req.headers['mcp-session-id']);

    let session: SessionRecord;
    if (sessionHeader !== undefined) {
      const existing = this.#sessions.get(sessionHeader);
      if (existing === undefined) {
        // Unknown session ID: either expired by the sweeper or one a
        // misbehaving client invented. Return 404 — the SDK convention
        // for an unknown session — so the client can re-initialize.
        respondJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32_000, message: 'unknown session' },
          id: null,
        });
        return;
      }
      if (
        existing.tenantName !== ctx.tenantName ||
        existing.serverName !== ctx.serverName
      ) {
        // A bearer leaked between tenants on the same host would
        // otherwise let one sandbox replay another's session ID.
        respondJson(res, 401, {
          jsonrpc: '2.0',
          error: { code: -32_001, message: 'session/tenant mismatch' },
          id: null,
        });
        return;
      }
      session = existing;
    } else {
      // No session header → only `initialize` is legal. Create a fresh
      // session and let `transport.handleRequest` parse the body. If
      // the body isn't an initialize, the SDK transport rejects it.
      session = this.#createSession(ctx);
    }

    session.lastActive = Date.now();
    await session.transport.handleRequest(req, res, body);
  }

  /**
   * Tear down all sessions and upstream clients. Idempotent.
   */
  async close(): Promise<void> {
    if (this.#sweeper !== null) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(
      sessions.map(async (s) => {
        try {
          await s.transport.close();
        } catch (err) {
          logger.debug(`mcp-forwarder: transport.close: ${errorMessage(err)}`);
        }
      }),
    );
    const upstreams = [...this.#upstreams.values()];
    this.#upstreams.clear();
    await Promise.all(
      upstreams.map(async (u) => {
        if (u.client === null) return;
        try {
          await u.client.close();
        } catch (err) {
          logger.debug(`mcp-forwarder: client.close: ${errorMessage(err)}`);
        }
      }),
    );
  }

  #ensureSweeperRunning(): void {
    if (this.#sweeper !== null) return;
    // Run the sweeper at one quarter the idle window so an expired
    // session is dropped within at most 1.25× the configured idle time.
    const tick = Math.max(this.#sessionIdleMs >> 2, 5000);
    this.#sweeper = setInterval(() => {
      this.#sweep();
    }, tick);
    this.#sweeper.unref();
  }

  #sweep(): void {
    const cutoff = Date.now() - this.#sessionIdleMs;
    this.#dropSessionsWhere((s) => s.lastActive < cutoff, 'idle timeout');
  }

  /**
   * Drop every session for which `predicate` is true. Single chokepoint
   * for session eviction so cleanup semantics (logging, transport close,
   * map removal) stay identical across callers (catalog reload + idle
   * sweep).
   */
  #dropSessionsWhere(
    predicate: (session: SessionRecord) => boolean,
    reason: string,
  ): void {
    for (const [id, session] of this.#sessions) {
      if (predicate(session)) this.#dropSession(id, reason);
    }
  }

  #dropSession(id: string, reason: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    this.#sessions.delete(id);
    logger.debug(
      `mcp-forwarder: drop session ${id} (${session.tenantName}/${session.serverName}): ${reason}`,
    );
    session.transport.close().catch((err: unknown) => {
      logger.debug(
        `mcp-forwarder: transport.close on drop: ${errorMessage(err)}`,
      );
    });
  }

  #createSession(ctx: ForwardContext): SessionRecord {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(
      { name: 'aurica-sandbox-mcp-gateway', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    // `record` is declared before the transport so the
    // `onsessioninitialized` callback can close over it without a
    // forward reference. The transport is patched in immediately after
    // construction.
    const record: SessionRecord = {
      tenantName: ctx.tenantName,
      serverName: ctx.serverName,
      policies: ctx.policies,
      defaultAction: ctx.defaultAction,
      server,
      // Filled in on the next line; `record` itself is only read inside
      // the SDK's deferred `onsessioninitialized` callback, which fires
      // long after the assignment below.
      transport: undefined as unknown as StreamableHTTPServerTransport,
      lastActive: Date.now(),
    };
    record.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        // The SDK assigns the session ID *after* construction; bind the
        // record to the live id here.
        record.lastActive = Date.now();
        this.#sessions.set(sessionId, record);
        logger.debug(
          `mcp-forwarder: session ${sessionId} initialized (${ctx.tenantName}/${ctx.serverName})`,
        );
      },
      onsessionclosed: (sessionId) => {
        this.#sessions.delete(sessionId);
        logger.debug(`mcp-forwarder: session ${sessionId} closed by client`);
      },
    });

    server.setRequestHandler(ListToolsRequestSchema, () =>
      this.#handleListTools(ctx),
    );
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.#handleCallTool(ctx, request.params),
    );

    // Bind the server to the transport so it receives JSON-RPC traffic.
    // `connect` resolves immediately for the Streamable HTTP transport
    // (per-request lifecycle), so the floating promise just kicks off
    // the wiring. The SDK's transport types declare optional callback
    // fields as `T | undefined` rather than `T?`, so we go through
    // `unknown` to satisfy our stricter `exactOptionalPropertyTypes`.
    server
      .connect(
        record.transport as unknown as Parameters<typeof server.connect>[0],
      )
      .catch((err: unknown) => {
        logger.error(
          `mcp-forwarder: server.connect failed: ${errorMessage(err)}`,
        );
      });

    return record;
  }

  async #handleListTools(ctx: ForwardContext): Promise<ListToolsResult> {
    let upstream: Client;
    try {
      upstream = await this.#getUpstream(ctx.serverName);
    } catch (err) {
      if (err instanceof UpstreamLoginRequiredError) {
        // Surface as an MCP-shaped error: no tools, plus a structured
        // message the guest can show. Returning an empty list rather
        // than throwing keeps `tools/list` itself succeeding so Claude
        // Code doesn't mark the server as offline.
        return {
          tools: [],
          _meta: {
            'aurica.mcp.error': 'login_required',
            'aurica.mcp.server': err.server,
            'aurica.mcp.message': err.message,
          },
        };
      }
      throw err;
    }
    const upstreamResult = await upstream.listTools();
    const filtered = filterToolsForList(
      upstreamResult.tools,
      ctx.policies,
      ctx.defaultAction,
    );
    return { ...upstreamResult, tools: filtered };
  }

  async #handleCallTool(
    ctx: ForwardContext,
    params: { name: string; arguments?: Record<string, unknown> | undefined },
  ): Promise<CallToolResult> {
    const decision = matchToolCall(ctx.policies, ctx.defaultAction, params);
    if (!decision.allow) {
      return {
        isError: true,
        content: [{ type: 'text', text: decision.reason }],
      };
    }
    let upstream: Client;
    try {
      upstream = await this.#getUpstream(ctx.serverName);
    } catch (err) {
      if (err instanceof UpstreamLoginRequiredError) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `${err.message}\nRun \`aurica-sandbox mcp login ${err.server}\` on the host.`,
            },
          ],
        };
      }
      throw err;
    }
    const result = await upstream.callTool({
      name: params.name,
      arguments: params.arguments,
    });
    return result as CallToolResult;
  }

  async #getUpstream(name: string): Promise<Client> {
    const existing = this.#upstreams.get(name);
    if (existing !== undefined) {
      if (existing.client !== null) return existing.client;
      if (existing.connectPromise !== null) {
        await existing.connectPromise;
        // After the await, the in-flight connect populated `client` (or
        // the connect failed and `client` is still null). The narrower
        // can't see across the await, so coerce via runtime check.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (existing.client === null) {
          throw new UpstreamLoginRequiredError(
            name,
            `${name} is not connected; run \`aurica-sandbox mcp login ${name}\``,
          );
        }
        return existing.client;
      }
    }

    const entry = this.#catalog.get(name);
    if (entry === undefined) {
      throw new UpstreamLoginRequiredError(
        name,
        `${name} is not configured in user config`,
      );
    }

    const record: UpstreamRecord =
      entry.auth.type === 'oauth'
        ? {
            authType: 'oauth',
            url: entry.url,
            clientMetadata: entry.auth.clientMetadata,
            provider: new FileOAuthProvider({
              upstream: name,
              redirectUrl: 'http://127.0.0.1/unused',
              clientMetadata: entry.auth.clientMetadata,
              onAuthorizationUrl: () => {
                throw new UpstreamLoginRequiredError(
                  name,
                  `${name} requires interactive authorization`,
                );
              },
            }),
            client: null,
            connectPromise: null,
          }
        : {
            authType: 'bearer',
            url: entry.url,
            tokenSource: entry.auth.tokenSource,
            client: null,
            connectPromise: null,
          };
    this.#upstreams.set(name, record);
    record.connectPromise = this.#connectUpstream(name, record);
    await record.connectPromise;
    record.connectPromise = null;
    if (record.client === null) {
      throw new UpstreamLoginRequiredError(
        name,
        `${name} could not be connected`,
      );
    }
    return record.client;
  }

  async #connectUpstream(name: string, record: UpstreamRecord): Promise<void> {
    if (record.authType === 'oauth') {
      await this.#connectOAuthUpstream(name, record);
      return;
    }
    await this.#connectBearerUpstream(name, record);
  }

  async #connectOAuthUpstream(
    name: string,
    record: OAuthUpstreamRecord,
  ): Promise<void> {
    // The SDK's `Client` doesn't expose token state directly, so we
    // probe via the provider first: a missing token is a definitive
    // "needs login" signal and short-circuits the connect attempt.
    const tokens = await record.provider.tokens();
    if (tokens === undefined || tokens.access_token === '') {
      // Attempt refresh; if there's no refresh_token either, this will
      // throw and propagate as login-required.
      let authResult: 'AUTHORIZED' | 'REDIRECT';
      try {
        authResult = await auth(record.provider, { serverUrl: record.url });
      } catch (err) {
        throw new UpstreamLoginRequiredError(
          name,
          `no cached tokens for ${name}; run \`aurica-sandbox mcp login ${name}\` (refresh failed: ${errorMessage(err)})`,
        );
      }
      if (authResult !== 'AUTHORIZED') {
        throw new UpstreamLoginRequiredError(
          name,
          `${name} requires re-authorization`,
        );
      }
    }

    const transport = new StreamableHTTPClientTransport(new URL(record.url), {
      authProvider: record.provider,
    });
    await this.#bindClient(name, record, transport);
  }

  async #connectBearerUpstream(
    name: string,
    record: BearerUpstreamRecord,
  ): Promise<void> {
    if (this.#bearerTokenResolver === undefined) {
      // Static-auth upstreams need a resolver to expand `env:...` etc.
      // Misconfiguration on the sidecar side — fail loudly so it
      // surfaces in the proxy log on first call.
      throw new UpstreamLoginRequiredError(
        name,
        `${name} is configured as bearer-auth but the gateway was not given a credential resolver; this is a programming error`,
      );
    }
    let token: string;
    try {
      token = await this.#bearerTokenResolver.resolve(record.tokenSource);
    } catch (err) {
      throw new UpstreamLoginRequiredError(
        name,
        `failed to resolve credential ${record.tokenSource} for ${name}: ${errorMessage(err)}`,
      );
    }
    const transport = new StreamableHTTPClientTransport(new URL(record.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    await this.#bindClient(name, record, transport);
  }

  async #bindClient(
    name: string,
    record: UpstreamRecord,
    transport: StreamableHTTPClientTransport,
  ): Promise<void> {
    const client = new Client({
      name: 'aurica-sandbox-gateway',
      version: '0.1.0',
    });
    try {
      // See the comment on the server-side connect above re: the cast.
      await client.connect(
        transport as unknown as Parameters<typeof client.connect>[0],
      );
    } catch (err) {
      throw new UpstreamLoginRequiredError(
        name,
        `${name} connect failed: ${errorMessage(err)}`,
      );
    }
    record.client = client;
    logger.debug(
      `mcp-forwarder: upstream ${name} connected (auth=${record.authType})`,
    );
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
