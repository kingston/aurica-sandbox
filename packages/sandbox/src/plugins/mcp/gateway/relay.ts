import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

import { logger } from '#src/logger.js';

import { FileOAuthProvider } from './file-oauth-provider.js';

/**
 * Per-upstream configuration the gateway needs to relay traffic.
 *
 * `url` is the upstream MCP base URL (e.g.
 * `https://api.githubcopilot.com/mcp/`). The remainder of the guest's path
 * after the gateway's `/<server>/mcp` prefix is appended verbatim.
 *
 * `clientMetadata` is the client metadata used during refresh — it
 * mirrors what `mcp login` registered with the upstream so the SDK's
 * `auth()` helper doesn't try to re-register on every refresh.
 */
export interface UpstreamCatalogEntry {
  url: string;
  clientMetadata: OAuthClientMetadata;
}

/**
 * Map of `<server>` (gateway path segment) → upstream config. The
 * gateway looks up incoming requests by the path segment captured from
 * `/<server>/mcp/...`.
 */
export type UpstreamCatalog = ReadonlyMap<string, UpstreamCatalogEntry>;

/**
 * Hop-by-hop headers that must not be forwarded between guest↔gateway and
 * gateway↔upstream. Defined by RFC 7230 §6.1 plus a few Node-specific
 * synthetic ones (`host`, `content-length`) we replace ourselves. Names
 * are lowercased because we compare against normalized header maps.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // We always set Authorization ourselves; the guest's placeholder is
  // never forwarded as-is. (The proxy is supposed to swap it, but defense
  // in depth: drop here so a misconfigured proxy doesn't leak the
  // sandbox's bearer token upstream.)
  'authorization',
  // Host is reset by `fetch`; carrying through the guest's would break
  // upstream routing (the guest sees `aurica.mcp.internal`).
  'host',
  // Let fetch compute these from the body.
  'content-length',
]);

/**
 * Per-upstream slot held by {@link UpstreamRelay}. Lazy-initialized on
 * first request: building a `FileOAuthProvider` synchronously is cheap,
 * but we keep it cached so its in-memory `codeVerifier` lifecycle (and
 * any future caches inside the provider) is shared across requests for
 * the same upstream.
 */
interface UpstreamSlot {
  url: string;
  provider: FileOAuthProvider;
}

/**
 * Stateless-from-the-guest's-POV HTTP relay that:
 *   1. Looks up the per-upstream slot (lazy-creating on first hit).
 *   2. Pulls the cached access token from {@link FileOAuthProvider}.
 *   3. Forwards the request via `fetch`, injecting `Authorization:
 *      Bearer <token>` and stripping hop-by-hop headers.
 *   4. On upstream 401 attempts one refresh via the SDK's `auth()`
 *      helper and retries; on still-failure surfaces a structured error
 *      naming the upstream so the user knows to run `mcp login`.
 *   5. Pipes the response straight back to the guest. Response bodies
 *      are passed through as a Node stream so SSE streams arrive
 *      unbuffered.
 *
 * The relay is deliberately HTTP-level: routing through the SDK's
 * high-level `Client` would force every JSON-RPC envelope through
 * `callTool`/`listTools`-style methods and lose fidelity for
 * server-initiated SSE notifications and any non-standard MCP methods.
 */
/**
 * Options for {@link UpstreamRelay}. All fields are test-only knobs;
 * production callers construct with `new UpstreamRelay()`.
 */
export interface UpstreamRelayOptions {
  /**
   * Override the path to `credentials.json`. Threaded into every
   * lazily-created {@link FileOAuthProvider} so tests can point at a
   * temp file. Production reads the default location from
   * `paths.credentialsFilePath()`.
   */
  credentialsPath?: string;
}

export class UpstreamRelay {
  #catalog: UpstreamCatalog = new Map();
  readonly #slots = new Map<string, UpstreamSlot>();
  readonly #credentialsPath: string | undefined;

  constructor(opts: UpstreamRelayOptions = {}) {
    this.#credentialsPath = opts.credentialsPath;
  }

  /**
   * Replace the upstream catalog. Called by the sidecar whenever user
   * config changes. Slots for upstreams removed from the catalog are
   * dropped so an `mcp logout` followed by a removed-upstream config
   * doesn't leak the old provider.
   */
  setCatalog(catalog: UpstreamCatalog): void {
    this.#catalog = catalog;
    const toDelete: string[] = [];
    for (const name of this.#slots.keys()) {
      if (!catalog.has(name)) toDelete.push(name);
    }
    for (const name of toDelete) this.#slots.delete(name);
  }

  /**
   * Forward an authenticated guest request to its upstream. The path
   * segment matched by the gateway's regex (`server`) selects the
   * upstream; the remainder of the URL after `/<server>/mcp` is appended
   * to the upstream base URL (preserving query string).
   *
   * On unrecoverable auth failure the response is a JSON object with a
   * `mcp_login_required` discriminator so a caller can distinguish it
   * from an upstream-emitted 401.
   */
  async forward(
    server: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const slot = this.#slotFor(server);
    if (slot === null) {
      sendLoginRequired(
        res,
        server,
        `upstream ${server} is not configured in user config`,
      );
      return;
    }

    const tokens = await slot.provider.tokens();
    if (tokens === undefined || tokens.access_token === '') {
      sendLoginRequired(
        res,
        server,
        `no cached tokens for upstream ${server}; run \`aurica-sandbox mcp login ${server}\``,
      );
      return;
    }

    // Build the upstream URL once; reused across initial + retry.
    const upstreamUrl = buildUpstreamUrl(slot.url, server, req.url ?? '/');
    if (upstreamUrl === null) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request' }));
      return;
    }

    // Buffer the request body so we can replay it on 401-refresh-retry.
    // MCP request bodies are JSON-RPC envelopes — small enough that
    // buffering is cheaper than the alternative (rewinding a stream).
    const body = await readRequestBody(req);

    const initial = await this.#dispatchOnce(
      upstreamUrl,
      req,
      body,
      tokens.access_token,
    );
    if (initial.response.status !== 401) {
      pipeResponse(initial.response, res);
      return;
    }

    // 401: try one refresh + retry. `auth()` with no authorization code
    // walks the SDK's refresh path when a refresh_token is cached; it
    // returns `AUTHORIZED` on success or `REDIRECT` if the upstream
    // wants a full re-auth (which we can't drive headlessly).
    initial.response.body?.cancel().catch((err: unknown) => {
      logger.debug(
        `mcp-gateway: ignored upstream body cancel error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    let authResult: 'AUTHORIZED' | 'REDIRECT';
    try {
      authResult = await auth(slot.provider, { serverUrl: slot.url });
    } catch (err) {
      logger.warn(
        `mcp-gateway: refresh for ${server} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendLoginRequired(
        res,
        server,
        `token refresh for ${server} failed; run \`aurica-sandbox mcp login ${server}\``,
      );
      return;
    }
    if (authResult !== 'AUTHORIZED') {
      sendLoginRequired(
        res,
        server,
        `${server} requires re-authorization; run \`aurica-sandbox mcp login ${server}\``,
      );
      return;
    }

    const refreshed = await slot.provider.tokens();
    if (refreshed === undefined) {
      sendLoginRequired(
        res,
        server,
        `${server} refresh succeeded but no tokens are cached; run \`aurica-sandbox mcp login ${server}\``,
      );
      return;
    }

    const retried = await this.#dispatchOnce(
      upstreamUrl,
      req,
      body,
      refreshed.access_token,
    );
    pipeResponse(retried.response, res);
  }

  #slotFor(server: string): UpstreamSlot | null {
    const cached = this.#slots.get(server);
    if (cached) return cached;
    const entry = this.#catalog.get(server);
    if (!entry) return null;
    const slot: UpstreamSlot = {
      url: entry.url,
      // `redirectUrl` only matters for fresh authorizations; refresh
      // doesn't use it. Leave it pointed at localhost as a stable
      // placeholder rather than an empty string (some SDKs validate
      // the field type even when unused).
      provider: new FileOAuthProvider({
        upstream: server,
        redirectUrl: 'http://127.0.0.1/unused',
        clientMetadata: entry.clientMetadata,
        onAuthorizationUrl: () => {
          // Reached only on a fresh-authorization attempt from inside
          // `auth()`. The relay never drives that — `mcp login` does —
          // so if we hit it here something is wrong with the cached
          // client info; rejecting forces the user back to `mcp login`.
          throw new Error(
            `mcp-gateway: ${server} requires interactive authorization`,
          );
        },
        credentialsPath: this.#credentialsPath,
      }),
    };
    this.#slots.set(server, slot);
    return slot;
  }

  async #dispatchOnce(
    upstreamUrl: URL,
    req: IncomingMessage,
    body: Buffer | null,
    accessToken: string,
  ): Promise<{ response: Response }> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(name, v);
      } else {
        headers.set(name, value);
      }
    }
    headers.set('Authorization', `Bearer ${accessToken}`);

    const method = (req.method ?? 'GET').toUpperCase();
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
    };
    if (body !== null && body.length > 0) {
      init.body = body;
      // Required for streaming POSTs in Node's fetch — even though we
      // pass a full buffer, undici still wants `duplex: 'half'` for
      // any body on a method that allows one.
      init.duplex = 'half';
    }

    const response = await fetch(upstreamUrl, init);
    return { response };
  }
}

/**
 * Build the upstream URL from `<baseUrl> + <remainder after /<server>/mcp>`.
 * Returns `null` for a path that doesn't match the gateway's expected
 * shape — the caller has already matched the pattern, so this is a
 * defensive check (a stale router could call us with an unexpected
 * path).
 */
function buildUpstreamUrl(
  baseUrl: string,
  server: string,
  guestPath: string,
): URL | null {
  // Strip the gateway-side prefix `/<server>/mcp`; preserve everything
  // after, including any trailing path segments and the query string.
  const prefix = `/${server}/mcp`;
  // Parse with a fake origin so we can isolate path + search.
  let parsed: URL;
  try {
    parsed = new URL(guestPath, 'http://x');
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith(prefix)) return null;
  const tail = parsed.pathname.slice(prefix.length);
  // Join with the upstream base. `new URL(tail, base)` would replace
  // the base path if `tail` starts with `/`, so we trim leading slashes
  // and ensure the base ends with one.
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const trimmedTail = tail.replace(/^\/+/, '');
  let result: URL;
  try {
    result = new URL(trimmedTail, base);
  } catch {
    return null;
  }
  result.search = parsed.search;
  return result;
}

/**
 * Buffer the request body into a single Buffer. MCP JSON-RPC envelopes
 * are bounded by realistic JSON message sizes, not arbitrarily large
 * uploads, so a full buffer is acceptable here — and necessary so the
 * 401→refresh→retry path can replay the same body without rewinding a
 * stream.
 *
 * Returns `null` for GET-like requests with no body.
 */
async function readRequestBody(req: IncomingMessage): Promise<Buffer | null> {
  // `IncomingMessage` will emit zero chunks for a GET; we still want a
  // null marker rather than an empty Buffer so the caller can skip
  // setting `body` on `fetch` entirely.
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

/**
 * Forward a `fetch`'s `Response` to a Node `ServerResponse`, including
 * SSE/stream bodies. Hop-by-hop headers are stripped on the way back
 * because the guest's HTTP/1.1 framing is determined by the proxy, not
 * the upstream.
 */
function pipeResponse(upstream: Response, res: ServerResponse): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    const existing = headers[name];
    if (existing === undefined) {
      headers[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headers[name] = [existing, value];
    }
  }
  res.writeHead(upstream.status, upstream.statusText, headers);

  if (upstream.body === null) {
    res.end();
    return;
  }
  // `Readable.fromWeb` adapts the WHATWG stream from `fetch` to a Node
  // Readable. `pipe` forwards `end`, so the client sees a clean close
  // when the upstream stream finishes.
  const node = Readable.fromWeb(upstream.body as never);
  node.on('error', (err) => {
    logger.warn(
      `mcp-gateway: upstream stream error: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.destroy(err);
  });
  node.pipe(res);
}

/**
 * Emit a JSON object signaling "the user needs to run `mcp login`" at
 * HTTP 401 with a distinct `mcp_login_required` discriminator. Returning
 * 401 (rather than 200 with a JSON-RPC error) makes the failure
 * surfaceable at every MCP client layer, including ones that don't
 * surface JSON-RPC errors back to the user.
 */
function sendLoginRequired(
  res: ServerResponse,
  server: string,
  message: string,
): void {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': `Bearer error="invalid_token", error_description="${server}"`,
  });
  res.end(
    JSON.stringify({
      error: 'mcp_login_required',
      server,
      message,
    }),
  );
}
