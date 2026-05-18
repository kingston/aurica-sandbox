import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpGateway } from './gateway.js';
import { UpstreamRelay, type UpstreamCatalogEntry } from './relay.js';

interface UpstreamHandle {
  url: string;
  close: () => Promise<void>;
  /** Last request seen by the fake upstream. */
  last: () => {
    method: string;
    path: string;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  };
  /** Override what the fake upstream returns. Default 200 with JSON ok. */
  setResponder: (
    fn: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ) => void;
}

async function startFakeUpstream(): Promise<UpstreamHandle> {
  let lastSeen: {
    method: string;
    path: string;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  } = { method: '', path: '', headers: {}, body: Buffer.alloc(0) };
  let responder: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastSeen = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: { ...req.headers },
        body: Buffer.concat(chunks),
      };
      responder(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    last: () => lastSeen,
    setResponder: (fn) => {
      responder = fn;
    },
  };
}

async function makeTempCreds(initial: object): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-relay-test-'));
  const p = path.join(dir, 'credentials.json');
  await fs.writeFile(p, JSON.stringify(initial, null, 2), { mode: 0o600 });
  return p;
}

function catalogEntry(url: string): UpstreamCatalogEntry {
  return {
    url,
    clientMetadata: {
      client_name: 'aurica-sandbox-test',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://127.0.0.1/unused'],
    },
  };
}

async function fetchVia(
  port: number,
  pathname: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string; headers: Headers }> {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  return { status: r.status, body: await r.text(), headers: r.headers };
}

describe('UpstreamRelay (via McpGateway)', () => {
  let upstream: UpstreamHandle;
  let gateway: McpGateway;
  let bound: { host: string; port: number };
  let credsPath: string;

  beforeEach(async () => {
    upstream = await startFakeUpstream();
  });

  afterEach(async () => {
    await gateway.close();
    await upstream.close();
  });

  it('forwards POST body and injects Bearer; strips Authorization placeholder', async () => {
    credsPath = await makeTempCreds({
      version: 1,
      upstreams: {
        github: {
          clientInformation: {
            client_id: 'test-client',
            redirect_uris: ['http://127.0.0.1/unused'],
          },
          tokens: { access_token: 'real-token', token_type: 'Bearer' },
        },
      },
    });
    const relay = new UpstreamRelay({ credentialsPath: credsPath });
    relay.setCatalog(new Map([['github', catalogEntry(upstream.url)]]));
    gateway = new McpGateway({ host: '127.0.0.1', relay });
    bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'secret-1',
        sourceIp: '127.0.0.1',
        enabledServers: ['github'],
      },
    ]);

    const r = await fetchVia(bound.port, '/github/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-1',
        'X-Forwarded-For': '127.0.0.1',
        'content-type': 'application/json',
        'x-custom': 'kept',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });

    const seen = upstream.last();
    expect(seen.method).toBe('POST');
    // The upstream sees the upstream-side bearer, not the guest's.
    expect(seen.headers.authorization).toBe('Bearer real-token');
    expect(seen.headers['x-custom']).toBe('kept');
    expect(JSON.parse(seen.body.toString('utf8'))).toEqual({
      jsonrpc: '2.0',
      method: 'ping',
      id: 1,
    });
  });

  it('returns 401 mcp_login_required when no tokens are cached', async () => {
    credsPath = await makeTempCreds({
      version: 1,
      upstreams: {
        github: {
          clientInformation: { client_id: 'c1' },
        },
      },
    });
    const relay = new UpstreamRelay({ credentialsPath: credsPath });
    relay.setCatalog(new Map([['github', catalogEntry(upstream.url)]]));
    gateway = new McpGateway({ host: '127.0.0.1', relay });
    bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'secret-1',
        sourceIp: '127.0.0.1',
        enabledServers: ['github'],
      },
    ]);

    const r = await fetchVia(bound.port, '/github/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-1',
        'X-Forwarded-For': '127.0.0.1',
      },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toMatchObject({
      error: 'mcp_login_required',
      server: 'github',
    });
    // Upstream must not have been contacted.
    expect(upstream.last().method).toBe('');
  });

  it('returns 401 mcp_login_required when upstream is not in the catalog', async () => {
    credsPath = await makeTempCreds({ version: 1, upstreams: {} });
    const relay = new UpstreamRelay({ credentialsPath: credsPath });
    relay.setCatalog(new Map());
    gateway = new McpGateway({ host: '127.0.0.1', relay });
    bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'secret-1',
        sourceIp: '127.0.0.1',
        enabledServers: ['github'],
      },
    ]);

    const r = await fetchVia(bound.port, '/github/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-1',
        'X-Forwarded-For': '127.0.0.1',
      },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toMatchObject({ error: 'mcp_login_required' });
  });

  it('pipes streaming response bodies (SSE) through unchanged', async () => {
    credsPath = await makeTempCreds({
      version: 1,
      upstreams: {
        github: {
          clientInformation: { client_id: 'c1' },
          tokens: { access_token: 't', token_type: 'Bearer' },
        },
      },
    });
    const relay = new UpstreamRelay({ credentialsPath: credsPath });
    relay.setCatalog(new Map([['github', catalogEntry(upstream.url)]]));
    gateway = new McpGateway({ host: '127.0.0.1', relay });
    bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'secret-1',
        sourceIp: '127.0.0.1',
        enabledServers: ['github'],
      },
    ]);

    upstream.setResponder((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\ndata: 1\n\n');
      res.write('event: b\ndata: 2\n\n');
      res.end();
    });

    const r = await fetchVia(bound.port, '/github/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-1',
        'X-Forwarded-For': '127.0.0.1',
      },
      body: '{}',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(r.body).toContain('event: a');
    expect(r.body).toContain('event: b');
  });

  it('appends path segments after /<server>/mcp to the upstream URL', async () => {
    credsPath = await makeTempCreds({
      version: 1,
      upstreams: {
        github: {
          clientInformation: { client_id: 'c1' },
          tokens: { access_token: 't', token_type: 'Bearer' },
        },
      },
    });
    const relay = new UpstreamRelay({ credentialsPath: credsPath });
    relay.setCatalog(
      new Map([['github', catalogEntry(`${upstream.url}/base`)]]),
    );
    gateway = new McpGateway({ host: '127.0.0.1', relay });
    bound = await gateway.listen();
    gateway.setTenants([
      {
        name: 'sb-1',
        bearer: 'secret-1',
        sourceIp: '127.0.0.1',
        enabledServers: ['github'],
      },
    ]);

    await fetchVia(bound.port, '/github/mcp/sub?x=1', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-1',
        'X-Forwarded-For': '127.0.0.1',
      },
      body: '{}',
    });
    const seen = upstream.last();
    expect(seen.path).toBe('/base/sub?x=1');
  });
});
