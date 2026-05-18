import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SandboxEntry } from '#src/state/index.js';

import { McpGateway, type TenantEntry } from './gateway.js';

function sampleSandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: 'sb-1',
    projectDir: '/tmp/proj',
    status: 'running',
    ip: '127.0.0.1',
    createdAt: '2026-05-16T00:00:00.000Z',
    authSecret: 'secret-1',
    ...overrides,
  };
}

const tenant: TenantEntry = {
  name: 'sb-1',
  bearer: 'secret-1',
  sourceIp: '127.0.0.1',
  enabledServers: ['github'],
};

describe('McpGateway.identify', () => {
  let gateway: McpGateway;

  beforeEach(() => {
    gateway = new McpGateway();
    gateway.setTenants([tenant]);
  });

  it('accepts a well-formed path + bearer + matching forwarded ip', () => {
    const r = gateway.identify('/github/mcp', 'Bearer secret-1', '127.0.0.1');
    expect(r).toEqual({ ok: true, tenant, server: 'github' });
  });

  it('accepts trailing path segments after /mcp', () => {
    const r = gateway.identify(
      '/github/mcp/sub/path',
      'Bearer secret-1',
      '127.0.0.1',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects malformed paths', () => {
    const r = gateway.identify('/foo', 'Bearer secret-1', '127.0.0.1');
    expect(r).toEqual({ ok: false, reason: 'bad-path' });
  });

  it('rejects missing bearer header', () => {
    const r = gateway.identify('/github/mcp', undefined, '127.0.0.1');
    expect(r).toEqual({ ok: false, reason: 'no-bearer' });
  });

  it('rejects bearer token mismatch as unauthenticated', () => {
    const r = gateway.identify('/github/mcp', 'Bearer wrong', '127.0.0.1');
    expect(r).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('rejects a server not in the tenant enabled list', () => {
    const r = gateway.identify('/linear/mcp', 'Bearer secret-1', '127.0.0.1');
    expect(r).toEqual({ ok: false, reason: 'server-not-enabled' });
  });

  it('rejects missing X-Forwarded-For as source-ip-mismatch', () => {
    const r = gateway.identify('/github/mcp', 'Bearer secret-1', undefined);
    expect(r).toEqual({ ok: false, reason: 'source-ip-mismatch' });
  });

  it('rejects an X-Forwarded-For that does not match the tenant', () => {
    const r = gateway.identify('/github/mcp', 'Bearer secret-1', '10.0.0.99');
    expect(r).toEqual({ ok: false, reason: 'source-ip-mismatch' });
  });

  it('uses the leftmost entry of a comma-separated X-Forwarded-For', () => {
    const r = gateway.identify(
      '/github/mcp',
      'Bearer secret-1',
      '127.0.0.1, 10.0.0.99',
    );
    expect(r.ok).toBe(true);
  });
});

describe('McpGateway.buildTenants', () => {
  it('skips sandboxes without an IP', () => {
    const tenants = McpGateway.buildTenants(
      [sampleSandbox({ ip: null })],
      () => ['github'],
      (sb) => `bearer-${sb.name}`,
    );
    expect(tenants).toEqual([]);
  });

  it('builds one tenant per ready sandbox', () => {
    const tenants = McpGateway.buildTenants(
      [
        sampleSandbox({ name: 'a', authSecret: 's-a', ip: '10.0.0.1' }),
        sampleSandbox({ name: 'b', authSecret: 's-b', ip: '10.0.0.2' }),
      ],
      (sb) => [sb.name === 'a' ? 'github' : 'linear'],
      (sb) => `bearer-${sb.name}`,
    );
    expect(tenants).toEqual([
      {
        name: 'a',
        bearer: 'bearer-a',
        sourceIp: '10.0.0.1',
        enabledServers: ['github'],
      },
      {
        name: 'b',
        bearer: 'bearer-b',
        sourceIp: '10.0.0.2',
        enabledServers: ['linear'],
      },
    ]);
  });
});

describe('McpGateway listener', () => {
  let gateway: McpGateway;
  let bound: { host: string; port: number };

  beforeEach(async () => {
    gateway = new McpGateway({ host: '127.0.0.1' });
    bound = await gateway.listen();
    gateway.setTenants([tenant]);
  });

  afterEach(async () => {
    await gateway.close();
  });

  it('reports its bound port via address()', () => {
    expect(gateway.address()).toEqual(bound);
  });

  it('returns 401 for missing bearer', async () => {
    const status = await fetchStatus(`/github/mcp`, bound.port);
    expect(status).toBe(401);
  });

  it('returns 404 for unrecognized paths', async () => {
    const status = await fetchStatus(`/no/such/route`, bound.port);
    expect(status).toBe(404);
  });

  it('returns 503 once auth+routing pass but no relay is attached', async () => {
    // Construction default omits the relay, so a successfully-identified
    // request short-circuits with the structured "relay not configured"
    // error rather than hanging or 500'ing.
    const status = await fetchStatus(`/github/mcp`, bound.port, {
      Authorization: 'Bearer secret-1',
      'X-Forwarded-For': '127.0.0.1',
    });
    expect(status).toBe(503);
  });

  it('refusing to listen twice', async () => {
    await expect(gateway.listen()).rejects.toThrow(/already listening/);
  });

  it('close() is idempotent', async () => {
    await gateway.close();
    await gateway.close();
    expect(gateway.address()).toBeNull();
  });
});

async function fetchStatus(
  pathname: string,
  port: number,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
