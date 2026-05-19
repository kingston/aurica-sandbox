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

/**
 * Per-upstream configuration the gateway needs to forward MCP traffic.
 * Mirrors the relay shape it replaces so the surrounding plugin doesn't
 * need to know which forwarder strategy is in use.
 *
 * `url` is the upstream MCP base URL (e.g.
 * `https://mcp.linear.app/mcp`). `clientMetadata` is the OAuth client
 * metadata used during refresh; it must match what `mcp login`
 * originally registered or the SDK will try to re-register on every
 * refresh.
 */
export interface UpstreamCatalogEntry {
  url: string;
  clientMetadata: OAuthClientMetadata;
}

/** Map of upstream name → upstream config. See {@link UpstreamCatalogEntry}. */
export type UpstreamCatalog = ReadonlyMap<string, UpstreamCatalogEntry>;

/** Options for {@link McpForwarder}. */
export interface McpForwarderOptions {
  /**
   * Override the credentials file path. Threaded into every
   * lazily-created {@link FileOAuthProvider}; tests use this to redirect
   * to a tempfile.
   */
  credentialsPath?: string;
  /**
   * Idle timeout in milliseconds after which an inactive session is
   * dropped. Clients are supposed to send DELETE on shutdown but rarely
   * do; without a sweeper, stale sessions would accumulate over the
   * proxy's lifetime.
   */
  sessionIdleMs?: number;
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
interface UpstreamRecord {
  url: string;
  clientMetadata: OAuthClientMetadata;
  provider: FileOAuthProvider;
  client: Client | null;
  connectPromise: Promise<void> | null;
}

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
  readonly #credentialsPath: string | undefined;
  readonly #sessionIdleMs: number;
  #sweeper: NodeJS.Timeout | null = null;

  constructor(opts: McpForwarderOptions = {}) {
    this.#credentialsPath = opts.credentialsPath;
    this.#sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
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
    for (const [id, session] of this.#sessions) {
      if (!catalog.has(session.serverName)) {
        this.#dropSession(id, 'upstream removed from catalog');
      }
    }
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
    for (const [id, session] of this.#sessions) {
      if (session.lastActive < cutoff) {
        this.#dropSession(id, 'idle timeout');
      }
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

    const provider = new FileOAuthProvider({
      upstream: name,
      redirectUrl: 'http://127.0.0.1/unused',
      clientMetadata: entry.clientMetadata,
      onAuthorizationUrl: () => {
        throw new UpstreamLoginRequiredError(
          name,
          `${name} requires interactive authorization`,
        );
      },
      credentialsPath: this.#credentialsPath,
    });
    const record: UpstreamRecord = {
      url: entry.url,
      clientMetadata: entry.clientMetadata,
      provider,
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
    logger.debug(`mcp-forwarder: upstream ${name} connected`);
  }
}

/**
 * Filter the upstream's `tools/list` to what the guest is allowed to
 * see. With `defaultAction === 'allow'`, every upstream tool passes;
 * otherwise only tools mentioned by at least one policy are shown.
 * Argument constraints don't apply here — args aren't known until
 * `tools/call`, and we'd rather expose the tool name (so the guest can
 * attempt a call) than hide it because *some* arg combination is
 * blocked.
 */
function filterToolsForList<T extends { name: string }>(
  tools: T[],
  policies: readonly CanonicalToolPolicy[],
  defaultAction: 'allow' | 'block',
): T[] {
  if (defaultAction === 'allow') return tools;
  const allow = new Set<string>();
  for (const p of policies) for (const t of p.tools) allow.add(t);
  return tools.filter((t) => allow.has(t.name));
}

/**
 * Outcome of {@link matchToolCall}. On denial, `reason` carries a
 * human-readable description of *why* the call was refused so the
 * forwarder can surface it to the guest. Two failure shapes:
 *
 * - `tool-not-allowed`: the tool name doesn't appear in any policy
 *   (with `defaultAction: 'block'`). The guest is calling a tool the
 *   sandbox simply isn't permitted to invoke.
 * - `argument-mismatch`: at least one policy named the tool, but each
 *   such policy had at least one `arguments` constraint that didn't
 *   match. `failures` lists per-policy details so a guest can see
 *   what value would have been accepted.
 */
type ToolCallDecision = { allow: true } | { allow: false; reason: string };

interface ArgumentMismatch {
  key: string;
  expected: string | number | boolean;
  /** `actual` is `undefined` when the call omitted the key entirely. */
  actual: unknown;
}

/**
 * First-match-wins evaluation of a `tools/call` against the per-server
 * policy list. A policy matches when `params.name` is in `policy.tools`
 * AND every key in `policy.arguments` (if set) equals (`===`) the
 * corresponding value on `params.arguments`. Extra keys on the call
 * are ignored (subset semantics). Missing key on the call = no match.
 *
 * No policy matched → fall through to `defaultAction`. When the result
 * is a denial, `reason` distinguishes "tool not in any policy" from
 * "policy named the tool but args didn't satisfy it" and lists the
 * specific mismatched key(s) so the caller can present an actionable
 * error.
 */
function matchToolCall(
  policies: readonly CanonicalToolPolicy[],
  defaultAction: 'allow' | 'block',
  params: { name: string; arguments?: Record<string, unknown> | undefined },
): ToolCallDecision {
  const callArgs = params.arguments ?? {};
  // Per-policy mismatch records, only populated when a policy named the
  // tool but its `arguments` constraints were not satisfied.
  const argFailures: { mismatches: ArgumentMismatch[] }[] = [];
  let toolNameMatched = false;

  for (const policy of policies) {
    if (!policy.tools.includes(params.name)) continue;
    toolNameMatched = true;
    if (policy.arguments === undefined) {
      return { allow: true };
    }
    const mismatches: ArgumentMismatch[] = [];
    for (const [key, expected] of Object.entries(policy.arguments)) {
      const actual = callArgs[key];
      if (actual !== expected) mismatches.push({ key, expected, actual });
    }
    if (mismatches.length === 0) return { allow: true };
    argFailures.push({ mismatches });
  }

  if (defaultAction === 'allow') return { allow: true };

  if (!toolNameMatched) {
    return {
      allow: false,
      reason: `tool ${params.name} is not allowed for this sandbox`,
    };
  }

  // Tool name matched at least one policy but every such policy failed
  // on args. Report the first policy's failure — listing all of them
  // tends to be more noise than help, and first-match-wins is already
  // the evaluation order so the first failure is the most relevant.
  const first = argFailures[0];
  if (first === undefined) {
    // Defensive: shouldn't happen — toolNameMatched implies at least
    // one policy ran arg checks and either passed (would've returned
    // above) or pushed to argFailures.
    return { allow: false, reason: `tool ${params.name} is not allowed` };
  }
  const detail = first.mismatches
    .map((m) => formatArgumentMismatch(m))
    .join('; ');
  return {
    allow: false,
    reason: `tool ${params.name} call denied: ${detail}`,
  };
}

function formatArgumentMismatch(m: ArgumentMismatch): string {
  if (m.actual === undefined) {
    return `argument "${m.key}" is required (expected ${JSON.stringify(m.expected)}, but it was missing from the call)`;
  }
  return `argument "${m.key}" must equal ${JSON.stringify(m.expected)} (got ${JSON.stringify(m.actual)})`;
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
