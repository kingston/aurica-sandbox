import fs from 'node:fs/promises';
import path from 'node:path';

import lockfile from 'proper-lockfile';
import type { z } from 'zod';

/**
 * Idempotently create `filePath` as a mode-0600 file holding the
 * JSON-stringified `seed`. Concurrent callers race through `wx`; whichever
 * loses sees `EEXIST` and treats the file as already present.
 */
async function ensureFile(filePath: string, seed: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
    return;
  } catch {
    // fall through to create
  }
  try {
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(seed, null, 2)}\n`);
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/**
 * Read + zod-parse a JSON file. Returns `seed` when the file is missing
 * or empty, so callers can treat an absent file as "empty document".
 */
async function readUnlocked<T>(
  filePath: string,
  schema: z.ZodType<T>,
  seed: T,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return seed;
    throw err;
  }
  if (!raw.trim()) return seed;
  const parsed: unknown = JSON.parse(raw);
  return schema.parse(parsed);
}

/**
 * Atomically write `data` to `filePath` via temp file + rename. The temp
 * file is opened mode-0600 so the final file inherits the same permissions
 * through `rename`.
 */
async function writeAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Generic lock-guarded read-mutate-write helper for a JSON file. Shared
 * by the metadata store and the secrets store so they get identical
 * concurrency + atomicity semantics from one source. Pattern mirrors
 * `state/store.ts`'s `withState`.
 *
 * `seed` is the default document returned when the file is missing.
 * `schema` validates the on-disk shape on every read; a corrupt file
 * surfaces as a zod error rather than silent data loss.
 */
export async function withJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  seed: T,
  mutator: (current: T) => T | Promise<T>,
): Promise<{ file: T; result: T }> {
  await ensureFile(filePath, seed);
  const release = await lockfile.lock(filePath, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
  });
  try {
    const current = await readUnlocked(filePath, schema, seed);
    const next = await mutator(current);
    await writeAtomic(filePath, next);
    return { file: next, result: next };
  } finally {
    await release();
  }
}

/**
 * Lock-free read of a JSON file. Use for read-only paths where callers
 * tolerate seeing a value mid-write (no torn writes, just possibly-stale
 * data). Mutators must go through {@link withJsonFile}.
 */
export async function readJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  seed: T,
): Promise<T> {
  return readUnlocked(filePath, schema, seed);
}
