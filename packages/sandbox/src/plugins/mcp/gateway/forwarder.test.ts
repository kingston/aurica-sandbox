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
}

async function startFakeUpstream(): Promise<FakeUpstreamHandle> {
  let lastCall: { name: string; args: unknown } | null = null;
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
  };
}

async function makeTempCreds(initial: object): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'aurica-forwarder-test-'),
  );
  const p = path.join(dir, 'credentials.json');
  await fs.writeFile(p, JSON.stringify(initial, null, 2), { mode: 0o600 });
  return p;
}

function catalogEntry(url: string): UpstreamCatalogEntry {
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'aurica-sandbox-test',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    redirect_uris: ['http://127.0.0.1/unused'],
  };
  return { url, clientMetadata };
}

/**
 * Stand up the gateway + forwarder + fake upstream + a real MCP
 * client pointed at the gateway with the correct bearer / XFF
 * headers. Returns a teardown that closes everything.
 */
interface Harness {
  client: Client;
  upstream: FakeUpstreamHandle;
  close: () => Promise<void>;
}

async function harness(
  serverName: string,
  serverEntry: { name: string; tools: readonly string[] | undefined },
): Promise<Harness> {
  const upstream = await startFakeUpstream();
  const credsPath = await makeTempCreds({
    version: 1,
    upstreams: {
      [serverName]: {
        clientInformation: { client_id: 'test-client' },
        tokens: { access_token: 'test-token', token_type: 'Bearer' },
      },
    },
  });
  const forwarder = new McpForwarder({ credentialsPath: credsPath });
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
    close: async () => {
      await client.close();
      await gateway.close();
      await forwarder.close();
      await upstream.close();
    },
  };
}

describe('McpForwarder via McpGateway', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('exposes the upstream tool list to the guest verbatim when no ACL is set', async () => {
    h = await harness('github', { name: 'github', tools: undefined });
    const result = await h.client.listTools();
    expect(result.tools.map((t) => t.name).sort()).toEqual(['count', 'echo']);
  });

  it('filters the tool list to the per-sandbox ACL', async () => {
    h = await harness('github', { name: 'github', tools: ['echo'] });
    const result = await h.client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('forwards tools/call and returns the upstream result', async () => {
    h = await harness('github', { name: 'github', tools: undefined });
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

  it('refuses a tools/call for a tool outside the ACL', async () => {
    h = await harness('github', { name: 'github', tools: ['echo'] });
    const result = await h.client.callTool({
      name: 'count',
      arguments: { text: 'ignored' },
    });
    expect(result.isError).toBe(true);
    // The upstream must not have been touched.
    expect(h.upstream.lastCallArgs()).toBeNull();
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
    const credsPath = await makeTempCreds({
      version: 1,
      upstreams: { github: { clientInformation: { client_id: 'c1' } } },
    });
    const forwarder = new McpForwarder({ credentialsPath: credsPath });
    forwarder.setCatalog(new Map([['github', catalogEntry(upstream.url)]]));
    const gateway = new McpGateway({ host: '127.0.0.1', forwarder });
    const bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'sb-bearer',
        sourceIp: '127.0.0.1',
        servers: [{ name: 'github', tools: undefined }],
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
      close: async () => {
        await client.close();
        await gateway.close();
        await forwarder.close();
        await upstream.close();
      },
    };

    const result = await client.listTools();
    expect(result.tools).toEqual([]);
    expect(result._meta?.['aurica.mcp.error']).toBe('login_required');
    expect(result._meta?.['aurica.mcp.server']).toBe('github');
  });
});
