import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  writeUpstreamClient,
  writeUpstreamTokens,
} from './credentials-store.js';
import { McpForwarder, type UpstreamCatalogEntry } from './forwarder.js';
import { McpGateway } from './gateway.js';

/**
 * Fake upstream MCP server backed by the SDK's own primitives. Exposes
 * two tools (`echo`, `count`) so we can assert that filtering happens
 * on the gateway side, not on the upstream.
 */
interface FakeUpstreamHandle {
  url: string;
  close: () => Promise<void>;
  /** Last `tools/call` arguments seen, for round-trip assertions. */
  lastCallArgs: () => { name: string; args: unknown } | null;
  /**
   * Last `Authorization` request header observed by the upstream HTTP
   * server. Useful for bearer-auth tests: assert the gateway actually
   * stamped the resolved token onto the outbound request.
   */
  lastAuthHeader: () => string | null;
}

async function startFakeUpstream(): Promise<FakeUpstreamHandle> {
  let lastCall: { name: string; args: unknown } | null = null;
  let lastAuth: string | null = null;
  // One transport per session keyed by Mcp-Session-Id, mirroring the
  // example pattern in the SDK docs.
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    lastAuth = req.headers.authorization ?? null;
    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body: unknown = bodyText === '' ? undefined : JSON.parse(bodyText);
    let transport: StreamableHTTPServerTransport;
    const existing =
      sessionId !== undefined ? sessions.get(sessionId) : undefined;
    if (existing !== undefined) {
      transport = existing;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const mcp = new Server(
        { name: 'fake-upstream', version: '0.0.1' },
        { capabilities: { tools: {} } },
      );
      mcp.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
          {
            name: 'echo',
            description: 'returns its input',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          {
            name: 'count',
            description: 'count characters',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, (req) => {
        lastCall = { name: req.params.name, args: req.params.arguments };
        if (req.params.name === 'echo') {
          const args = req.params.arguments as { text?: string } | undefined;
          return {
            content: [{ type: 'text', text: args?.text ?? '' }],
          };
        }
        if (req.params.name === 'count') {
          const args = req.params.arguments as { text?: string } | undefined;
          return {
            content: [
              { type: 'text', text: String((args?.text ?? '').length) },
            ],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text', text: `unknown tool ${req.params.name}` }],
        };
      });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      // See gateway/forwarder.ts re: the cast (exactOptionalPropertyTypes).
      await mcp.connect(
        transport as unknown as Parameters<typeof mcp.connect>[0],
      );
    }
    await transport.handleRequest(req, res, body);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    lastCallArgs: () => lastCall,
    lastAuthHeader: () => lastAuth,
  };
}

/**
 * Per-test credentials home. Returned tempdir is registered as
 * `AURICA_HOME` so the slot factory writes here; cleanup is the caller's
 * responsibility (Harness.close handles it for the standard flow).
 */
interface CredsSandbox {
  dir: string;
  restore: () => Promise<void>;
}

async function makeCredsSandbox(seed?: {
  upstream: string;
  clientInformation?: unknown;
  tokens?: unknown;
}): Promise<CredsSandbox> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'aurica-forwarder-test-'),
  );
  const prev = process.env.AURICA_HOME;
  process.env.AURICA_HOME = dir;
  if (seed?.clientInformation !== undefined) {
    await writeUpstreamClient(seed.upstream, seed.clientInformation);
  }
  if (seed?.tokens !== undefined) {
    await writeUpstreamTokens(seed.upstream, seed.tokens);
  }
  return {
    dir,
    restore: async () => {
      if (prev === undefined) {
        delete process.env.AURICA_HOME;
      } else {
        process.env.AURICA_HOME = prev;
      }
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function catalogEntry(url: string): UpstreamCatalogEntry {
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'aurica-sandbox-test',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    redirect_uris: ['http://127.0.0.1/unused'],
  };
  return { url, auth: { type: 'oauth', clientMetadata } };
}

function bearerCatalogEntry(
  url: string,
  tokenSource: string,
): UpstreamCatalogEntry {
  return { url, auth: { type: 'bearer', tokenSource } };
}

/**
 * Stand up the gateway + forwarder + fake upstream + a real MCP
 * client pointed at the gateway with the correct bearer / XFF
 * headers. Returns a teardown that closes everything.
 */
interface Harness {
  client: Client;
  upstream: FakeUpstreamHandle;
  creds: CredsSandbox;
  close: () => Promise<void>;
}

async function harness(
  serverName: string,
  serverEntry: {
    name: string;
    policies: readonly {
      tools: readonly string[];
      arguments:
        | Readonly<Record<string, string | number | boolean>>
        | undefined;
    }[];
    defaultAction: 'allow' | 'block';
  },
): Promise<Harness> {
  const upstream = await startFakeUpstream();
  const creds = await makeCredsSandbox({
    upstream: serverName,
    clientInformation: { client_id: 'test-client' },
    tokens: { access_token: 'test-token', token_type: 'Bearer' },
  });
  const forwarder = new McpForwarder();
  forwarder.setCatalog(new Map([[serverName, catalogEntry(upstream.url)]]));
  const gateway = new McpGateway({ host: '127.0.0.1', forwarder });
  const bound = await gateway.listen();
  gateway.setTenants([
    {
      name: 'sb-1',
      bearer: 'sb-bearer',
      sourceIp: '127.0.0.1',
      servers: [serverEntry],
      enabledServers: [serverEntry.name],
    },
  ]);

  // Drive the gateway from an actual MCP client; that way the test
  // exercises the full Streamable HTTP handshake, not just one POST.
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${bound.port}/${serverName}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: 'Bearer sb-bearer',
          'X-Forwarded-For': '127.0.0.1',
        },
      },
    },
  );
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(
    transport as unknown as Parameters<typeof client.connect>[0],
  );
  return {
    client,
    upstream,
    creds,
    close: async () => {
      await client.close();
      await gateway.close();
      await forwarder.close();
      await upstream.close();
      await creds.restore();
    },
  };
}

const allowAll = {
  name: 'github',
  policies: [] as const,
  defaultAction: 'allow' as const,
};

describe('McpForwarder via McpGateway', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('exposes the upstream tool list verbatim when defaultAction is allow', async () => {
    h = await harness('github', allowAll);
    const result = await h.client.listTools();
    expect(result.tools.map((t) => t.name).sort()).toEqual(['count', 'echo']);
  });

  it('tools/list returns only the union of policy-mentioned tools when default is block', async () => {
    h = await harness('github', {
      name: 'github',
      policies: [{ tools: ['echo'], arguments: undefined }],
      defaultAction: 'block',
    });
    const result = await h.client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('forwards tools/call and returns the upstream result', async () => {
    h = await harness('github', allowAll);
    const result = await h.client.callTool({
      name: 'echo',
      arguments: { text: 'hello world' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(h.upstream.lastCallArgs()).toEqual({
      name: 'echo',
      args: { text: 'hello world' },
    });
  });

  it('refuses a tools/call for a tool with no matching policy', async () => {
    h = await harness('github', {
      name: 'github',
      policies: [{ tools: ['echo'], arguments: undefined }],
      defaultAction: 'block',
    });
    const result = await h.client.callTool({
      name: 'count',
      arguments: { text: 'ignored' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'tool count is not allowed for this sandbox' },
    ]);
    expect(h.upstream.lastCallArgs()).toBeNull();
  });

  it('allows a tools/call when args satisfy the policy (subset equality)', async () => {
    h = await harness('github', {
      name: 'github',
      policies: [{ tools: ['echo'], arguments: { text: 'hello' } }],
      defaultAction: 'block',
    });
    // Extra arg `flair` is ignored — subset semantics.
    const result = await h.client.callTool({
      name: 'echo',
      arguments: { text: 'hello', flair: '!' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('refuses a tools/call when a required arg key is missing, naming the missing key', async () => {
    h = await harness('github', {
      name: 'github',
      policies: [{ tools: ['echo'], arguments: { text: 'hello' } }],
      defaultAction: 'block',
    });
    const result = await h.client.callTool({
      name: 'echo',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'tool echo call denied: argument "text" is required (expected "hello", but it was missing from the call)',
      },
    ]);
    expect(h.upstream.lastCallArgs()).toBeNull();
  });

  it('refuses a tools/call when an arg value differs from the policy, reporting expected vs actual', async () => {
    h = await harness('github', {
      name: 'github',
      policies: [{ tools: ['echo'], arguments: { text: 'hello' } }],
      defaultAction: 'block',
    });
    const result = await h.client.callTool({
      name: 'echo',
      arguments: { text: 'world' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'tool echo call denied: argument "text" must equal "hello" (got "world")',
      },
    ]);
    expect(h.upstream.lastCallArgs()).toBeNull();
  });

  it('reports every mismatched argument in one message when multiple keys are wrong', async () => {
    h = await harness('github', {
      name: 'github',
      policies: [{ tools: ['echo'], arguments: { text: 'hello', flair: '!' } }],
      defaultAction: 'block',
    });
    const result = await h.client.callTool({
      name: 'echo',
      arguments: { text: 'world' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'tool echo call denied: argument "text" must equal "hello" (got "world"); ' +
          'argument "flair" is required (expected "!", but it was missing from the call)',
      },
    ]);
    expect(h.upstream.lastCallArgs()).toBeNull();
  });

  it('first-match-wins: a later, broader policy catches what an earlier, narrower one rejected', async () => {
    h = await harness('github', {
      name: 'github',
      policies: [
        { tools: ['echo'], arguments: { text: 'only-this' } },
        { tools: ['echo'], arguments: undefined },
      ],
      defaultAction: 'block',
    });
    const result = await h.client.callTool({
      name: 'echo',
      arguments: { text: 'whatever' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'whatever' }]);
  });
});

describe('McpForwarder login-required surfaces', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('returns an empty tools/list with login_required metadata when no tokens are cached', async () => {
    const upstream = await startFakeUpstream();
    const creds = await makeCredsSandbox({
      upstream: 'github',
      clientInformation: { client_id: 'c1' },
    });
    const forwarder = new McpForwarder();
    forwarder.setCatalog(new Map([['github', catalogEntry(upstream.url)]]));
    const gateway = new McpGateway({ host: '127.0.0.1', forwarder });
    const bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'sb-bearer',
        sourceIp: '127.0.0.1',
        servers: [{ name: 'github', policies: [], defaultAction: 'allow' }],
        enabledServers: ['github'],
      },
    ]);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${bound.port}/github/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: 'Bearer sb-bearer',
            'X-Forwarded-For': '127.0.0.1',
          },
        },
      },
    );
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(
      transport as unknown as Parameters<typeof client.connect>[0],
    );
    h = {
      client,
      upstream,
      creds,
      close: async () => {
        await client.close();
        await gateway.close();
        await forwarder.close();
        await upstream.close();
        await creds.restore();
      },
    };

    const result = await client.listTools();
    expect(result.tools).toEqual([]);
    expect(result._meta?.['aurica.mcp.error']).toBe('login_required');
    expect(result._meta?.['aurica.mcp.server']).toBe('github');
  });
});

describe('McpForwarder bearer-auth upstream', () => {
  let teardown: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await teardown?.();
    teardown = undefined;
  });

  /**
   * Boots a forwarder with a single `bearer`-auth upstream and a
   * scripted `bearerTokenResolver` so the test can observe whether the
   * resolver was called and verify the gateway stamped the resolved
   * token onto the outbound `Authorization` header.
   */
  async function boot(opts: {
    resolver: (rawSource: string) => Promise<string>;
  }): Promise<{
    client: Client;
    upstream: FakeUpstreamHandle;
  }> {
    const upstream = await startFakeUpstream();
    const forwarder = new McpForwarder({
      bearerTokenResolver: { resolve: opts.resolver },
    });
    forwarder.setCatalog(
      new Map([['github-pat', bearerCatalogEntry(upstream.url, 'env:GH_PAT')]]),
    );
    const gateway = new McpGateway({ host: '127.0.0.1', forwarder });
    const bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'sb-bearer',
        sourceIp: '127.0.0.1',
        servers: [{ name: 'github-pat', policies: [], defaultAction: 'allow' }],
        enabledServers: ['github-pat'],
      },
    ]);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${bound.port}/github-pat/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: 'Bearer sb-bearer',
            'X-Forwarded-For': '127.0.0.1',
          },
        },
      },
    );
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(
      transport as unknown as Parameters<typeof client.connect>[0],
    );
    teardown = async () => {
      await client.close();
      await gateway.close();
      await forwarder.close();
      await upstream.close();
    };
    return { client, upstream };
  }

  it('stamps the resolved bearer onto outbound MCP requests, bypassing OAuth', async () => {
    const calls: string[] = [];
    const { client, upstream } = await boot({
      resolver: (src) => {
        calls.push(src);
        return Promise.resolve('ghp_test_token');
      },
    });
    const result = await client.callTool({
      name: 'echo',
      arguments: { text: 'hi' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(calls).toEqual(['env:GH_PAT']);
    expect(upstream.lastAuthHeader()).toBe('Bearer ghp_test_token');
  });

  it('surfaces a login-required-shaped error when the resolver throws', async () => {
    const { client } = await boot({
      resolver: () => Promise.reject(new Error('GH_PAT not set')),
    });
    const result = await client.listTools();
    expect(result.tools).toEqual([]);
    expect(result._meta?.['aurica.mcp.error']).toBe('login_required');
    expect(String(result._meta?.['aurica.mcp.message'])).toContain(
      'failed to resolve credential env:GH_PAT',
    );
  });

  it('returns an isError tools/call result when the resolver throws, with a host-side login hint', async () => {
    const { client, upstream } = await boot({
      resolver: () => Promise.reject(new Error('GH_PAT not set')),
    });
    const result = await client.callTool({
      name: 'echo',
      arguments: { text: 'hi' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toContain('failed to resolve credential env:GH_PAT');
    expect(text).toContain('aurica-sandbox mcp login github-pat');
    // Upstream must never have been called — the resolver failed before
    // any outbound request could be made.
    expect(upstream.lastCallArgs()).toBeNull();
    expect(upstream.lastAuthHeader()).toBeNull();
  });
});

describe('McpForwarder bearer-auth without a credential resolver', () => {
  let teardown: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await teardown?.();
    teardown = undefined;
  });

  it('fails loudly when a bearer upstream is configured but no resolver was injected', async () => {
    const upstream = await startFakeUpstream();
    // No `bearerTokenResolver` passed — this is the misconfiguration we
    // want to surface as a clear login_required error rather than a
    // silent NPE.
    const forwarder = new McpForwarder();
    forwarder.setCatalog(
      new Map([['github-pat', bearerCatalogEntry(upstream.url, 'env:GH_PAT')]]),
    );
    const gateway = new McpGateway({ host: '127.0.0.1', forwarder });
    const bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'sb-bearer',
        sourceIp: '127.0.0.1',
        servers: [{ name: 'github-pat', policies: [], defaultAction: 'allow' }],
        enabledServers: ['github-pat'],
      },
    ]);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${bound.port}/github-pat/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: 'Bearer sb-bearer',
            'X-Forwarded-For': '127.0.0.1',
          },
        },
      },
    );
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(
      transport as unknown as Parameters<typeof client.connect>[0],
    );
    teardown = async () => {
      await client.close();
      await gateway.close();
      await forwarder.close();
      await upstream.close();
    };

    const result = await client.listTools();
    expect(result.tools).toEqual([]);
    expect(result._meta?.['aurica.mcp.error']).toBe('login_required');
    expect(String(result._meta?.['aurica.mcp.message'])).toContain(
      'was not given a credential resolver',
    );
  });
});
