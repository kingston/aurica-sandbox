import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { cacheDir } from '#src/config/index.js';

/**
 * A cached HTTP response: the raw on-the-wire body bytes plus the status and
 * headers needed to replay it verbatim. Headers are stored as-is so the
 * `content-encoding` declaration matches the raw `body`, and replayed via
 * mockttp's `rawBody` (which is sent without re-encoding).
 */
export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Sidecar metadata persisted next to each cached body. `storedAt` +
 * `ttlSeconds` decide expiry at read time; `url`/`method` are retained for
 * debugging and to make the cache directory self-describing.
 */
interface CacheMetadata {
  url: string;
  method: string;
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  storedAt: number;
  ttlSeconds: number;
}

/**
 * Stable cache key for a request: a sha256 hex of `METHOD\nURL`. The full URL
 * (host + path + query) is part of the key, so content-addressed download
 * URLs map to stable keys across sandboxes.
 */
export function cacheKey(method: string, url: string): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${url}`)
    .digest('hex');
}

function entryPaths(key: string): { bin: string; meta: string } {
  const dir = cacheDir();
  return {
    bin: path.join(dir, `${key}.bin`),
    meta: path.join(dir, `${key}.json`),
  };
}

/**
 * Read a cached response for `method` + `url`, or `null` if there is no entry
 * or it has expired. A corrupt or unreadable entry is treated as a miss (so a
 * partially-written entry never wedges the cache).
 */
export async function readCache(
  method: string,
  url: string,
): Promise<CachedResponse | null> {
  const key = cacheKey(method, url);
  const { bin, meta } = entryPaths(key);
  let metadata: CacheMetadata;
  try {
    metadata = JSON.parse(await fs.readFile(meta, 'utf8')) as CacheMetadata;
  } catch {
    return null;
  }
  if (Date.now() > metadata.storedAt + metadata.ttlSeconds * 1000) {
    return null;
  }
  let body: Buffer;
  try {
    body = await fs.readFile(bin);
  } catch {
    return null;
  }
  return { statusCode: metadata.statusCode, headers: metadata.headers, body };
}

/**
 * Store a response for `method` + `url` under the given TTL. Both files are
 * written atomically (temp + rename) so a concurrent reader never sees a
 * half-written body; the body is written before its metadata so a visible
 * metadata file always has a matching body. Caching is GET + 200 only — the
 * caller is responsible for that gate, but this asserts it defensively.
 */
export async function writeCache(
  method: string,
  url: string,
  response: CachedResponse & { ttlSeconds: number },
): Promise<void> {
  if (method.toUpperCase() !== 'GET' || response.statusCode !== 200) return;

  const key = cacheKey(method, url);
  const dir = cacheDir();
  await fs.mkdir(dir, { recursive: true });
  const { bin, meta } = entryPaths(key);

  // Unique temp suffix so two concurrent writes for the same key (e.g. two
  // sandboxes missing the same URL at once) don't clobber each other's temp
  // file before the atomic rename.
  const token = randomUUID();
  const binTmp = `${bin}.tmp.${token}`;
  await fs.writeFile(binTmp, response.body);
  await fs.rename(binTmp, bin);

  const metadata: CacheMetadata = {
    url,
    method: method.toUpperCase(),
    statusCode: response.statusCode,
    headers: response.headers,
    storedAt: Date.now(),
    ttlSeconds: response.ttlSeconds,
  };
  const metaTmp = `${meta}.tmp.${token}`;
  await fs.writeFile(metaTmp, `${JSON.stringify(metadata, null, 2)}\n`);
  await fs.rename(metaTmp, meta);
}
