import fs from 'node:fs/promises';
import path from 'node:path';

import lockfile from 'proper-lockfile';
import { z } from 'zod';

import { credentialsFilePath } from '#src/config/paths.js';

/**
 * On-disk per-upstream slice. Both fields are opaque blobs from the MCP
 * SDK's perspective (the SDK validates them on its way in and out); we
 * store them as `unknown` so the SDK schemas stay the source of truth
 * for shape. Wrapping with our own schema would mean re-deriving the
 * SDK's schemas — fragile and unnecessary.
 *
 * `clientInformation` holds the result of Dynamic Client Registration
 * (or a statically-known client) — written by `saveClientInformation`,
 * read by `clientInformation`.
 *
 * `tokens` holds the latest access / refresh token bundle — written by
 * `saveTokens`, read by `tokens`. The SDK persists refreshes here
 * automatically.
 */
const upstreamSlotSchema = z.object({
  clientInformation: z.unknown().optional(),
  tokens: z.unknown().optional(),
});

const credentialsFileSchema = z.object({
  version: z.literal(1).default(1),
  upstreams: z.record(z.string().min(1), upstreamSlotSchema).default({}),
});

/** Validated shape of the credentials file. */
export type CredentialsFile = z.infer<typeof credentialsFileSchema>;
/** A single upstream's persisted slot. */
export type UpstreamSlot = z.infer<typeof upstreamSlotSchema>;

const emptyFile: CredentialsFile = { version: 1, upstreams: {} };

async function ensureFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
    return;
  } catch {
    // fall through to create
  }
  try {
    // `wx` errors if the file exists. Two callers racing through
    // `ensureFile` are normal under `Promise.all([withCredentials(...),
    // withCredentials(...)])`; whichever loses the race sees `EEXIST`
    // and treats the file as already present. The lockfile in
    // `withCredentials` serializes subsequent reads/writes.
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(emptyFile, null, 2)}\n`);
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

async function readUnlocked(filePath: string): Promise<CredentialsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile;
    throw err;
  }
  if (!raw.trim()) return emptyFile;
  const parsed: unknown = JSON.parse(raw);
  return credentialsFileSchema.parse(parsed);
}

async function writeAtomic(
  filePath: string,
  data: CredentialsFile,
): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  // `wx` + mode 0600 on the tmp file ensures that even if the rename
  // somehow lands on a pre-existing path, we don't widen perms. The
  // final file inherits the tmp's mode through rename.
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Read the credentials file without locking. Returns the empty document
 * when the file is missing. Use for read-only paths (e.g. `mcp list`);
 * mutators must go through {@link withCredentials} for atomicity.
 */
export async function readCredentials(
  filePath: string = credentialsFilePath(),
): Promise<CredentialsFile> {
  return readUnlocked(filePath);
}

/**
 * Run `mutator` against the latest credentials file under an exclusive
 * file lock and write the result back atomically. Pattern mirrors
 * `state/store.ts`'s `withState`.
 */
export async function withCredentials<T>(
  mutator: (file: CredentialsFile) => T | Promise<T>,
  filePath: string = credentialsFilePath(),
): Promise<{ file: CredentialsFile; result: T }> {
  await ensureFile(filePath);
  const release = await lockfile.lock(filePath, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
  });
  try {
    const current = await readUnlocked(filePath);
    const result = await mutator(current);
    await writeAtomic(filePath, current);
    return { file: current, result };
  } finally {
    await release();
  }
}

/**
 * Convenience helpers for single-upstream slot operations. Built on top
 * of {@link withCredentials} so they remain atomic.
 */
export async function readUpstreamSlot(
  upstream: string,
  filePath: string = credentialsFilePath(),
): Promise<UpstreamSlot | undefined> {
  const file = await readCredentials(filePath);
  return file.upstreams[upstream];
}

export async function writeUpstreamSlot(
  upstream: string,
  slot: UpstreamSlot,
  filePath: string = credentialsFilePath(),
): Promise<void> {
  await withCredentials((file) => {
    file.upstreams[upstream] = slot;
  }, filePath);
}

export async function deleteUpstreamSlot(
  upstream: string,
  filePath: string = credentialsFilePath(),
): Promise<boolean> {
  const { result } = await withCredentials((file) => {
    const existed = upstream in file.upstreams;
    // The credentials file is a small keyed record (~10 entries)
    // written once per OAuth event; V8 fast-path concerns about
    // dictionary mode (per the no-dynamic-delete rule) don't apply.
    // Use object-spread to delete instead of `delete` to keep the
    // linter happy without the runtime trade-off it warns about.
    file.upstreams = Object.fromEntries(
      Object.entries(file.upstreams).filter(([k]) => k !== upstream),
    );
    return existed;
  }, filePath);
  return result;
}
