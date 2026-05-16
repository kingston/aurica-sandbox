import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as readline from 'node:readline/promises';

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Command } from 'commander';
import open from 'open';

import { logger } from '#src/logger.js';

import type { CliCommandContext } from '../../types.js';
import {
  deleteUpstreamSlot,
  readUpstreamSlot,
} from '../gateway/credentials-store.js';
import { FileOAuthProvider } from '../gateway/file-oauth-provider.js';
import { mcpUserConfigSchema, type McpUserConfig } from '../schema.js';

/**
 * Pull the `mcp` block out of `userConfig.plugins` and re-parse it through
 * the plugin's own schema. The framework types `plugins.<name>` as a union
 * across every registered plugin's user-config shape, so a property lookup
 * on the union doesn't narrow; re-parsing recovers the precise `McpUserConfig`
 * shape (and applies the empty-default for absent blocks).
 */
function readMcpUserConfig(userConfig: {
  plugins: Record<string, unknown>;
}): McpUserConfig {
  return mcpUserConfigSchema.parse(userConfig.plugins.mcp ?? {});
}

/**
 * Default client metadata sent during Dynamic Client Registration. The
 * upstream displays `client_name` to the user in the OAuth consent
 * screen, so a recognizable string is preferable over an opaque
 * identifier. Per-upstream overrides come from user config.
 *
 * `redirect_uris` is left blank here — the per-login callback URL is
 * built fresh each `mcp login` invocation (with a randomly-chosen
 * localhost port) and patched in before constructing the provider.
 */
const BASE_CLIENT_METADATA: Omit<OAuthClientMetadata, 'redirect_uris'> = {
  client_name: 'aurica-sandbox',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

interface LoginCallback {
  url: string;
  /** Resolves when the upstream's user-agent redirect arrives. */
  awaitCode(): Promise<string>;
  /** Tear down the loopback listener. Idempotent. */
  close(): void;
}

/**
 * Stand up a one-shot localhost HTTP server that accepts the OAuth
 * redirect. The server binds an ephemeral port so it never collides with
 * anything else on the host. The first `?code=…` (or `?error=…`) hit
 * resolves `awaitCode` and the listener immediately stops accepting new
 * connections.
 *
 * Async because `server.listen()` only assigns `address()` after the
 * `'listening'` event fires — reading it synchronously after a non-zero
 * port request races and intermittently returns null.
 */
async function createOAuthCallback(): Promise<LoginCallback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  let closed = false;
  const server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400).end('bad request');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end('not found');
      return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) {
      rejectCode(new Error(`OAuth error from upstream: ${error}`));
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`OAuth error: ${error}. You can close this tab.\n`);
      return;
    }
    if (!code) {
      rejectCode(new Error('OAuth callback missing `code` parameter'));
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Missing code. You can close this tab.\n');
      return;
    }
    resolveCode(code);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(
      'Login successful. You can close this tab and return to your terminal.\n',
    );
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const addr = server.address() as AddressInfo | null;
  if (addr === null) {
    throw new Error('failed to bind localhost callback listener');
  }
  return {
    url: `http://127.0.0.1:${addr.port}/callback`,
    awaitCode: async () => codePromise,
    close: () => {
      if (closed) return;
      closed = true;
      server.close();
    },
  };
}

/**
 * Run the OAuth dance for a single upstream. Designed to be called from
 * the `mcp login` subcommand and from tests; takes a configurable
 * `openUrl` hook so tests can intercept the would-be browser open.
 */
export async function runMcpLogin(
  upstream: string,
  options: {
    /** Loads the parsed user config. Injected by the CLI entry point. */
    loadUserConfig: CliCommandContext['loadUserConfig'];
    /** Override the default `open` browser launcher. Useful in tests. */
    openUrl?: (url: URL) => void | Promise<void>;
    /**
     * Override the credentials.json path. Used by tests; production
     * callers should leave unset.
     */
    credentialsPath?: string;
  },
): Promise<void> {
  const userConfig = await options.loadUserConfig();
  const mcp = readMcpUserConfig(userConfig);
  const upstreamConfig = mcp.upstreams[upstream];
  if (!upstreamConfig) {
    throw new Error(
      `unknown MCP upstream "${upstream}"; declare it under plugins.mcp.upstreams in your user config first`,
    );
  }

  const callback = await createOAuthCallback();
  try {
    const clientMetadata: OAuthClientMetadata = {
      ...BASE_CLIENT_METADATA,
      client_name:
        upstreamConfig.clientName ?? BASE_CLIENT_METADATA.client_name,
      redirect_uris: [callback.url],
    };

    const launchedUrl = createDeferredUrl();
    const provider = new FileOAuthProvider({
      upstream,
      redirectUrl: callback.url,
      clientMetadata,
      credentialsPath: options.credentialsPath,
      onAuthorizationUrl: async (url) => {
        launchedUrl.resolve(url);
        // Echo the URL before launching the browser so the user can
        // copy it from the terminal if the auto-open fails silently or
        // the consent tab gets closed before they finish.
        logger.info(`Opening browser for ${upstream} OAuth:`);
        logger.info(`  ${url.toString()}`);
        await (options.openUrl ? options.openUrl(url) : open(url.toString()));
      },
    });

    const client = new Client(
      { name: 'aurica-sandbox', version: '0.0.1' },
      // No capabilities surface needed for the login dance — we
      // disconnect immediately after auth succeeds. Capability
      // negotiation happens in the gateway at runtime, not here.
      { capabilities: {} },
    );

    // First attempt: connect with no tokens cached yet. The SDK kicks
    // off the OAuth redirect via the provider and rejects with
    // `UnauthorizedError`. We collect the code (loopback or paste),
    // hand it to `finishAuth` on the same transport (which stores the
    // tokens via the provider), then `connect` again on a **fresh**
    // transport — the SDK forbids restarting a transport that has
    // already been started, so we discard the first one.
    const first = newTransport(upstreamConfig.url, provider);
    try {
      await client.connect(first.asTransport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      await launchedUrl.promise;
      const code = await collectAuthCode(callback);
      await first.transport.finishAuth(code);
      await client.connect(newTransport(upstreamConfig.url, provider).asTransport);
    }

    await client.close();
    logger.info(`MCP upstream "${upstream}": login successful`);
  } finally {
    callback.close();
  }
}

/**
 * `aurica-sandbox mcp list` — show every configured upstream alongside
 * its credential status. Useful as a smoke test ("did login persist?")
 * and as input to a future `mcp doctor`.
 */
export async function runMcpList(
  options: {
    loadUserConfig: CliCommandContext['loadUserConfig'];
    credentialsPath?: string;
  },
): Promise<void> {
  const userConfig = await options.loadUserConfig();
  const mcp = readMcpUserConfig(userConfig);
  const upstreams = Object.entries(mcp.upstreams);
  if (upstreams.length === 0) {
    logger.info(
      'no MCP upstreams configured (add them under plugins.mcp.upstreams in user config)',
    );
    return;
  }
  for (const [name, cfg] of upstreams) {
    const slot = await readUpstreamSlot(name, options.credentialsPath);
    const status = slot?.tokens
      ? 'logged in'
      : slot?.clientInformation
        ? 'registered, no tokens'
        : 'not logged in';
    logger.info(`  ${name}  ${cfg.url}  [${status}]`);
  }
}

/**
 * `aurica-sandbox mcp logout <upstream>` — delete the cached client info
 * and tokens for one upstream. Does NOT revoke server-side (v1); a
 * follow-up `mcp revoke` could implement OAuth 2.0 revocation per RFC
 * 7009 if needed.
 */
export async function runMcpLogout(
  upstream: string,
  options: { credentialsPath?: string } = {},
): Promise<void> {
  const existed = await deleteUpstreamSlot(upstream, options.credentialsPath);
  if (existed) {
    logger.info(`MCP upstream "${upstream}": credentials cleared`);
  } else {
    logger.info(`MCP upstream "${upstream}": no cached credentials`);
  }
}

/**
 * Attach the `mcp` subcommand group to a Commander root program. Called
 * by the `mcp` plugin's `cliCommands` hook.
 */
export function registerMcpCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  const mcp = program
    .command('mcp')
    .description('manage authenticated upstream MCP servers');

  mcp
    .command('login <upstream>')
    .description('run the OAuth dance against a configured upstream MCP server')
    .action(async (upstream: string) => {
      await runMcpLogin(upstream, { loadUserConfig: ctx.loadUserConfig });
    });

  mcp
    .command('list')
    .description('list configured MCP upstreams and their auth status')
    .action(async () => {
      await runMcpList({ loadUserConfig: ctx.loadUserConfig });
    });

  mcp
    .command('logout <upstream>')
    .description('clear cached credentials for an MCP upstream')
    .action(async (upstream: string) => {
      await runMcpLogout(upstream);
    });
}

/**
 * Build a `StreamableHTTPClientTransport` wired to a `FileOAuthProvider`.
 * Factored out because the OAuth dance needs **two** transport
 * instances — one to drive the initial `UnauthorizedError` and consume
 * the code via `finishAuth`, a second (fresh) one to complete the
 * authenticated `client.connect`. The SDK rejects restarting a
 * transport that has already been started.
 *
 * The `Transport` cast bypasses an `exactOptionalPropertyTypes`
 * mismatch on `sessionId` between the concrete transport and the SDK's
 * `Transport` interface; no runtime hazard since we never read it.
 */
function newTransport(
  upstreamUrl: string,
  authProvider: FileOAuthProvider,
): { transport: StreamableHTTPClientTransport; asTransport: Transport } {
  const transport = new StreamableHTTPClientTransport(new URL(upstreamUrl), {
    authProvider,
  });
  return { transport, asTransport: transport as unknown as Transport };
}

/**
 * Helper: a Promise + resolver pair we can await before reading the
 * code from the callback listener. Lets `runMcpLogin` block on
 * `redirectToAuthorization` actually firing instead of racing the
 * callback with a not-yet-launched browser flow.
 */
function createDeferredUrl(): {
  promise: Promise<URL>;
  resolve: (url: URL) => void;
} {
  let resolveFn!: (url: URL) => void;
  const promise = new Promise<URL>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

/**
 * Resolve the OAuth `code` either from the loopback callback (the
 * normal path) or from the user pasting the redirect URL / code into
 * the terminal (the fallback for when the browser redirect can't reach
 * loopback — wrong network, closed tab, etc.). Whichever finishes first
 * wins; the loser is cancelled so the user isn't left at a dead prompt.
 *
 * Skips the paste prompt entirely when stdin isn't a TTY (CI, piped
 * input) — there's nobody to prompt.
 */
async function collectAuthCode(callback: LoginCallback): Promise<string> {
  const callbackPromise = callback.awaitCode();
  if (!process.stdin.isTTY) {
    return callbackPromise;
  }
  const ac = new AbortController();
  // When the paste prompt returns `null` (empty line / stdin closed) we
  // fall back to waiting on the loopback callback indefinitely — the
  // user might still complete the browser flow afterwards.
  const pastePromise: Promise<string> = promptForCodeOrUrl(ac.signal).then(
    (c) => c ?? callbackPromise,
  );
  try {
    return await Promise.race([callbackPromise, pastePromise]);
  } finally {
    ac.abort();
  }
}

/**
 * Read a line from stdin and try to recover an OAuth `code` from it.
 *
 * Accepts either:
 *   - the full redirect URL the user copied out of their browser
 *     (typical when the loopback callback never reached us — wrong
 *     network, the tab got closed, etc.), or
 *   - a bare authorization code pasted from the URL's `?code=…`
 *     query parameter.
 *
 * Returns `null` if the line is empty or stdin closes — callers race
 * this against the loopback callback, so giving up cleanly is fine.
 *
 * The `signal` lets the caller cancel the prompt the instant the
 * loopback callback wins the race, so we don't leave the user staring
 * at a dead prompt.
 */
async function promptForCodeOrUrl(signal: AbortSignal): Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    // `rl.question` natively honors `AbortSignal` (Node ≥ 17) and
    // rejects with an AbortError when the signal fires, which is the
    // only way to actually unblock a pending `question` — `rl.close()`
    // alone leaves the awaited promise dangling.
    const raw = await rl.question(
      'Or paste the redirect URL (or just the `code` value) and press Enter: ',
      { signal },
    );
    const answer = raw.trim();
    if (!answer) return null;
    // Two accepted shapes: a full URL with `?code=…`, or a bare code.
    if (/^https?:\/\//i.test(answer)) {
      const parsed = new URL(answer);
      const err = parsed.searchParams.get('error');
      if (err) throw new Error(`OAuth error from upstream: ${err}`);
      const code = parsed.searchParams.get('code');
      if (!code) {
        throw new Error('pasted URL has no `code` parameter');
      }
      return code;
    }
    return answer;
  } catch (err) {
    // AbortError on signal-trigger is expected: the loopback callback
    // won the race. Surface anything else.
    if (signal.aborted) return null;
    throw err;
  } finally {
    rl.close();
    // Newline so the next log line starts cleanly below the prompt
    // instead of being appended to it.
    if (process.stderr.isTTY) process.stderr.write('\n');
  }
}
