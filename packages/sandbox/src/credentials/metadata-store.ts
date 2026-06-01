import { z } from 'zod';

import { credentialsFilePath } from '#src/config/paths.js';

import { readJsonFile, withJsonFile } from '../utils/json-file.js';

/**
 * On-disk shape of the metadata half of the credentials store. Record
 * contents are deliberately `unknown` — the per-plugin record factory in
 * {@link './credential-record.js'} validates them; the store itself owns
 * only the key/value layout, locking, and atomic writes.
 *
 * `version: 2` is the current shape. It is kept so that a future
 * breaking schema change can emit a clean "delete and re-login" error
 * instead of a raw Zod parse failure.
 */
const metadataFileSchema = z.object({
  version: z.literal(2),
  records: z.record(z.string().min(1), z.unknown()).default({}),
});

/** Validated shape of the metadata file. */
export type MetadataFile = z.infer<typeof metadataFileSchema>;

const emptyFile: MetadataFile = { version: 2, records: {} };

/**
 * Read the metadata file without locking. Returns the empty document when
 * the file is missing. Use for read-only paths; mutators must go through
 * {@link withMetadata}.
 */
export async function readMetadata(
  filePath: string = credentialsFilePath(),
): Promise<MetadataFile> {
  return readJsonFile(filePath, metadataFileSchema, emptyFile);
}

/**
 * Run `mutator` against the latest metadata file under an exclusive lock
 * and write the result back atomically.
 */
export async function withMetadata<T>(
  mutator: (file: MetadataFile) => T | Promise<T>,
  filePath: string = credentialsFilePath(),
): Promise<{ file: MetadataFile; result: T }> {
  let captured!: T;
  const { file } = await withJsonFile(
    filePath,
    metadataFileSchema,
    emptyFile,
    async (current) => {
      captured = await mutator(current);
      return current;
    },
  );
  return { file, result: captured };
}

/**
 * Read a single record by namespaced key. The returned value is whatever
 * was written; the caller is responsible for validating it (typically
 * via {@link './credential-record.js'}'s `defineCredentialRecord`).
 */
export async function readMetadataRecord(
  key: string,
  filePath?: string,
): Promise<unknown> {
  const file = await readMetadata(filePath);
  return file.records[key];
}

/**
 * Write a single record by namespaced key. Other records are preserved.
 */
export async function writeMetadataRecord(
  key: string,
  value: unknown,
  filePath?: string,
): Promise<void> {
  await withMetadata((file) => {
    file.records[key] = value;
  }, filePath);
}

/**
 * Delete a single record by namespaced key. Returns `true` if a record
 * existed at that key, `false` otherwise.
 */
export async function deleteMetadataRecord(
  key: string,
  filePath?: string,
): Promise<boolean> {
  const { result } = await withMetadata((file) => {
    const existed = key in file.records;
    // Object-spread delete keeps the no-dynamic-delete linter happy.
    file.records = Object.fromEntries(
      Object.entries(file.records).filter(([k]) => k !== key),
    );
    return existed;
  }, filePath);
  return result;
}
