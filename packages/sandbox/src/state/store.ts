import fs from 'node:fs/promises';
import path from 'node:path';

import lockfile from 'proper-lockfile';
import { z } from 'zod';

import { stateFilePath } from '#src/config/index.js';

const sandboxEntrySchema = z.object({
  name: z.string(),
  projectDir: z.string(),
  status: z.enum([
    'creating',
    'starting',
    'running',
    'stopping',
    'stopped',
    'failed-init',
  ]),
  ip: z.string().nullable(),
  createdAt: z.string(),
});

export type SandboxEntry = z.infer<typeof sandboxEntrySchema>;

const proxyEntrySchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  port: z.number().int(),
  startedAt: z.string(),
});

export type ProxyEntry = z.infer<typeof proxyEntrySchema>;

export const stateSchema = z.object({
  version: z.literal(1).default(1),
  proxy: proxyEntrySchema.nullable().default(null),
  sandboxes: z.record(z.string(), sandboxEntrySchema).default({}),
});

export type State = z.infer<typeof stateSchema>;

const emptyState: State = { version: 1, proxy: null, sandboxes: {} };

async function ensureStateFileExists(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, `${JSON.stringify(emptyState, null, 2)}\n`);
  }
}

async function readUnlocked(filePath: string): Promise<State> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState;
    throw err;
  }
  if (!raw.trim()) return emptyState;
  const parsed: unknown = JSON.parse(raw);
  return stateSchema.parse(parsed);
}

async function writeAtomic(filePath: string, state: State): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, filePath);
}

/**
 * Read state from disk without locking. Returns the empty state if the file
 * is missing or empty. Read-only callers should prefer this over `withState`.
 */
export async function readState(
  filePath: string = stateFilePath(),
): Promise<State> {
  return readUnlocked(filePath);
}

/**
 * Run `mutator` against the latest state under an exclusive file lock and
 * write the result back atomically. The mutator is expected to mutate the
 * passed `State` in place; its return value is forwarded as `result`.
 */
export async function withState<T>(
  mutator: (state: State) => T | Promise<T>,
  filePath: string = stateFilePath(),
): Promise<{ state: State; result: T }> {
  await ensureStateFileExists(filePath);
  const release = await lockfile.lock(filePath, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
  });
  try {
    const before = await readUnlocked(filePath);
    const result = await mutator(before);
    await writeAtomic(filePath, before);
    return { state: before, result };
  } finally {
    await release();
  }
}
