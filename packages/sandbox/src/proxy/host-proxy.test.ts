import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { HostProxy } from './host-proxy.js';

interface Upstream {
  port: number;
  close: () => Promise<void>;
  lastAuth: () => string | undefined;
}

async function startUpstream(): Promise<Upstream> {
  let lastAuth: string | undefined;
  const server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((r) => {
        server.close(() => {
          r();
        });
      }),
    lastAuth: () => lastAuth,
  };
}

function fetchViaProxy(
  proxyHost: string,
  proxyPort: number,
  targetUrl: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxyHost,
        port: proxyPort,
        method: 'GET',
        path: targetUrl,
        headers: { host: new URL(targetUrl).host, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('HostProxy (mockttp-backed)', () => {
  let dir: string;
  let originalAuricaHome: string | undefined;
  let proxy: HostProxy;
  let proxyAddr: { host: string; port: number };
  let upstream: Upstream;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-proxy-'));
    originalAuricaHome = process.env.AURICA_HOME;
    process.env.AURICA_HOME = dir;

    upstream = await startUpstream();
    proxy = await HostProxy.create({
      resolver: {
        resolve(rawSource) {
          if (rawSource === 'env:TEST_TOKEN')
            return Promise.resolve('real-secret');
          return Promise.reject(new Error(`unknown source ${rawSource}`));
        },
      },
    });
    proxy.register('test', {
      sourceIp: '127.0.0.1',
      domains: ['127.0.0.1'],
      configDomains: ['127.0.0.1'],
      policies: [
        {
          id: 'test-policy',
          domain: '127.0.0.1',
          action: {
            type: 'allow',
            mutations: [
              {
                kind: 'replace-header',
                header: 'Authorization',
                from: 'placeholder-key',
                to: 'env:TEST_TOKEN',
              },
            ],
          },
        },
      ],
    });
    proxyAddr = await proxy.listen();
  }, 30_000);

  afterAll(async () => {
    await proxy.close();
    await upstream.close();
    if (originalAuricaHome === undefined) delete process.env.AURICA_HOME;
    else process.env.AURICA_HOME = originalAuricaHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('forwards an allowlisted request and substitutes the placeholder', async () => {
    const res = await fetchViaProxy(
      proxyAddr.host,
      proxyAddr.port,
      `http://127.0.0.1:${upstream.port}/`,
      { Authorization: 'Bearer placeholder-key' },
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    expect(upstream.lastAuth()).toBe('Bearer real-secret');
  });

  it('rejects a non-allowlisted host with 403', async () => {
    const res = await fetchViaProxy(
      proxyAddr.host,
      proxyAddr.port,
      `http://example.invalid/`,
      {},
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/not in allowlist/);
  });

  it('forwards an allowlisted request without a placeholder unchanged', async () => {
    const res = await fetchViaProxy(
      proxyAddr.host,
      proxyAddr.port,
      `http://127.0.0.1:${upstream.port}/`,
      { Authorization: 'Bearer untouched' },
    );
    expect(res.status).toBe(200);
    expect(upstream.lastAuth()).toBe('Bearer untouched');
  });

  it('register/unregister updates the live registration set', () => {
    proxy.register('other', {
      sourceIp: '127.0.0.1',
      domains: ['127.0.0.1', '*.example.com'],
      configDomains: ['127.0.0.1', '*.example.com'],
      policies: [],
    });
    const after = proxy.summary().flatMap((e) => e.configDomains);
    expect(new Set(after)).toEqual(new Set(['127.0.0.1', '*.example.com']));
    proxy.unregister('other');
    const afterUnregister = proxy.summary().flatMap((e) => e.configDomains);
    expect(new Set(afterUnregister)).toEqual(new Set(['127.0.0.1']));
  });

  it('rejects allowlisted hosts when the registration sourceIp is null', async () => {
    proxy.register('null-ip', {
      sourceIp: null,
      domains: ['null.example.com'],
      policies: [],
    });
    try {
      const res = await fetchViaProxy(
        proxyAddr.host,
        proxyAddr.port,
        `http://null.example.com/`,
        {},
      );
      expect(res.status).toBe(403);
    } finally {
      proxy.unregister('null-ip');
    }
  });

  it("does not leak one registration's allowlist to a different sourceIp", async () => {
    // Sandbox-A is registered for an unrelated IP and allowlists the upstream
    // host. The test client connects from 127.0.0.1, which is *not* sandbox-A's
    // sourceIp — so sandbox-A's allowlist must not apply to it. With the
    // primary 'test' registration unregistered, the request must 403.
    proxy.unregister('test');
    proxy.register('sandbox-A', {
      sourceIp: '10.0.0.42',
      domains: ['127.0.0.1'],
      policies: [],
    });
    try {
      const res = await fetchViaProxy(
        proxyAddr.host,
        proxyAddr.port,
        `http://127.0.0.1:${upstream.port}/`,
        {},
      );
      expect(res.status).toBe(403);
    } finally {
      proxy.unregister('sandbox-A');
      proxy.register('test', {
        sourceIp: '127.0.0.1',
        domains: ['127.0.0.1'],
        policies: [
          {
            id: 'test-policy',
            domain: '127.0.0.1',
            action: {
              type: 'allow',
              mutations: [
                {
                  kind: 'replace-header',
                  header: 'Authorization',
                  from: 'placeholder-key',
                  to: 'env:TEST_TOKEN',
                },
              ],
            },
          },
        ],
      });
    }
  });
});

describe('HostProxy on-demand reconcile (unregistered IP)', () => {
  let dir: string;
  let originalAuricaHome: string | undefined;
  let upstream: Upstream;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-proxy-unreg-'));
    originalAuricaHome = process.env.AURICA_HOME;
    process.env.AURICA_HOME = dir;
    upstream = await startUpstream();
  }, 30_000);

  afterAll(async () => {
    await upstream.close();
    if (originalAuricaHome === undefined) delete process.env.AURICA_HOME;
    else process.env.AURICA_HOME = originalAuricaHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const resolver = { resolve: () => Promise.reject(new Error('unused')) };

  let proxy: HostProxy;
  let addr: { host: string; port: number };

  afterEach(async () => {
    await proxy.close();
  });

  it('passes through after the hook registers the IP', async () => {
    const hook = vi.fn<(remoteIp: string) => Promise<void>>((remoteIp) => {
      // Simulate reconcile discovering the VM and registering its IP.
      proxy.register('healed', {
        sourceIp: remoteIp,
        domains: [`127.0.0.1`],
        policies: [],
      });
      return Promise.resolve();
    });
    proxy = await HostProxy.create({ resolver, onUnregisteredRequest: hook });
    addr = await proxy.listen();

    const res = await fetchViaProxy(
      addr.host,
      addr.port,
      `http://127.0.0.1:${upstream.port}/`,
      {},
    );
    expect(hook).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('denies with 403 when the hook leaves the IP unregistered', async () => {
    const hook = vi.fn<(remoteIp: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    proxy = await HostProxy.create({ resolver, onUnregisteredRequest: hook });
    addr = await proxy.listen();

    const res = await fetchViaProxy(
      addr.host,
      addr.port,
      `http://127.0.0.1:${upstream.port}/`,
      {},
    );
    expect(hook).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/unregistered IP/);
  });

  it('denies with 403 when no hook is configured', async () => {
    proxy = await HostProxy.create({ resolver });
    addr = await proxy.listen();

    const res = await fetchViaProxy(
      addr.host,
      addr.port,
      `http://127.0.0.1:${upstream.port}/`,
      {},
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/unregistered IP/);
  });
});
