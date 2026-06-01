import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HostProxy, type VerboseLogger } from './host-proxy.js';

/**
 * The consolidated-block log model defers rendering to the `response` event,
 * folding in the decision buffered at `beforeRequest`/the denial sweep. That
 * only works if mockttp emits a `response` event for the proxy's own
 * short-circuit 403s (allowlist denial and policy `block`). These tests drive
 * real requests through a live proxy and assert that, for each, both the
 * verbose decision fires AND a `response` event arrives carrying the same
 * request id — i.e. there is a terminal event to flush the buffered decision.
 */

function fetchViaProxy(
  proxyHost: string,
  proxyPort: number,
  targetUrl: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxyHost,
        port: proxyPort,
        method: 'GET',
        path: targetUrl,
        headers: { host: new URL(targetUrl).host },
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

describe('verbose block flush on proxy short-circuit 403s', () => {
  let dir: string;
  let originalAuricaHome: string | undefined;
  let proxy: HostProxy;
  let addr: { host: string; port: number };
  let blockUpstream: { port: number; close: () => Promise<void> };

  // Captured per request id: whether a verbose decision/denial was emitted,
  // and whether a response event fired (the event the flush relies on).
  const decisions = new Map<string, string>();
  const responses = new Map<string, number>();

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-verbose-'));
    originalAuricaHome = process.env.AURICA_HOME;
    process.env.AURICA_HOME = dir;

    // Upstream that exists only so a `block` policy has an allowlisted host to
    // short-circuit (the block fires before the request reaches it).
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    blockUpstream = {
      port,
      close: () =>
        new Promise((r) => {
          server.close(() => {
            r();
          });
        }),
    };

    const verboseLogger: VerboseLogger = (event) => {
      decisions.set(event.id, event.type);
    };
    proxy = await HostProxy.create({
      resolver: {
        resolve: () => Promise.reject(new Error('no creds in this test')),
      },
      verboseLogger,
    });
    // Allowlist 127.0.0.1 with a `block` policy so requests to it are
    // proxy-blocked (403) rather than passed through.
    proxy.register('blocker', {
      sourceIp: '127.0.0.1',
      domains: ['127.0.0.1'],
      policies: [
        { id: 'deny-all', domain: '127.0.0.1', action: { type: 'block' } },
      ],
    });
    addr = await proxy.listen();
    await proxy.setEventSubscriber(async (s) => {
      await s.on('response', (res) => {
        responses.set(res.id, res.statusCode);
      });
    });
  }, 30_000);

  afterAll(async () => {
    await proxy.close();
    await blockUpstream.close();
    if (originalAuricaHome === undefined) delete process.env.AURICA_HOME;
    else process.env.AURICA_HOME = originalAuricaHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('emits a response event for an allowlist denial (so the denial block can flush)', async () => {
    const status = await fetchViaProxy(
      addr.host,
      addr.port,
      'http://example.invalid/',
    );
    expect(status).toBe(403);
    // A denial decision was buffered and a 403 response event fired for the
    // same request — i.e. the flush path has a terminal event to render on.
    const denialIds = [...decisions.entries()].filter(
      ([, type]) => type === 'denial',
    );
    expect(denialIds.length).toBeGreaterThan(0);
    expect(denialIds.every(([id]) => responses.get(id) === 403)).toBe(true);
  });

  it('emits a response event for a policy block (so the block block can flush)', async () => {
    const status = await fetchViaProxy(
      addr.host,
      addr.port,
      `http://127.0.0.1:${blockUpstream.port}/`,
    );
    expect(status).toBe(403);
    const decisionIds = [...decisions.entries()].filter(
      ([, type]) => type === 'decision',
    );
    expect(decisionIds.length).toBeGreaterThan(0);
    expect(decisionIds.every(([id]) => responses.get(id) === 403)).toBe(true);
  });
});
