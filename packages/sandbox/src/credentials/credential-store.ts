import type { CredentialRecord } from './credential-record.js';
import {
  deleteMetadataRecord,
  readMetadataRecord,
  writeMetadataRecord,
} from './metadata-store.js';
import { defaultSecretVault, type SecretVault } from './secret-vault.js';

/**
 * Derives the key used to store `field` of `record` in the secret vault.
 * Shared between {@link CredentialStore} (writer) and `vaultCredentialProvider`
 * (reader) so the two sides can't drift independently.
 */
export function vaultSecretKey(recordKey: string, field: string): string {
  return `${recordKey}:${field}`;
}

/**
 * Options for constructing a {@link CredentialStore}.
 *
 * Both fields are optional; omit them in production and override in tests
 * (or let the `AURICA_HOME` env-var isolation handle it).
 */
export interface CredentialStoreOptions {
  /** Override the secret vault backing this store. Defaults to {@link defaultSecretVault}. */
  vault?: SecretVault;
  /**
   * Override the metadata file path forwarded to the metadata-store helpers.
   * Tests use a tmp path; production resolves lazily from `AURICA_HOME`.
   */
  metadataPath?: string;
}

/**
 * Orchestrates reads and writes that span both the metadata store
 * (`credentials.json`) and the secret vault (`secrets.json`). Callers
 * pass a {@link CredentialRecord} descriptor — which carries the key,
 * schema, and secret-field list — and the store handles the split:
 *
 * - **write**: secrets-first so a metadata-write failure leaves harmless
 *   orphan secrets rather than dangling metadata pointing at missing ones.
 * - **read**: recombines both halves; missing any secret field is treated
 *   as a logically corrupt record and returns `undefined`.
 * - **delete**: metadata-first so concurrent reads stop seeing the record
 *   before secrets are physically removed.
 */
export class CredentialStore {
  readonly #vault: SecretVault;
  readonly #metadataPath: string | undefined;

  constructor(opts?: CredentialStoreOptions) {
    this.#vault = opts?.vault ?? defaultSecretVault;
    this.#metadataPath = opts?.metadataPath;
  }

  /**
   * Read the full credential bundle for `record`, recombining metadata and
   * secret fields. Returns `undefined` when the metadata half is absent or
   * any secret field is missing.
   */
  async read<TMeta extends object, const TSecretField extends string>(
    record: CredentialRecord<TMeta, TSecretField>,
  ): Promise<(TMeta & Record<TSecretField, string>) | undefined> {
    const raw = await readMetadataRecord(record.key, this.#metadataPath);
    if (raw === undefined) return undefined;
    const metadata = record.metadataSchema.parse(raw);
    const secrets: Record<string, string> = {};
    for (const field of record.secretFields) {
      const value = await this.#vault.get(vaultSecretKey(record.key, field));
      if (value === undefined) return undefined;
      secrets[field] = value;
    }
    return { ...metadata, ...(secrets as Record<TSecretField, string>) };
  }

  /**
   * Write the full credential bundle for `record`. Validates metadata before
   * touching either store; writes secrets first.
   */
  async write<TMeta extends object, const TSecretField extends string>(
    record: CredentialRecord<TMeta, TSecretField>,
    data: TMeta extends Record<string, never>
      ? Record<TSecretField, string>
      : TMeta & Record<TSecretField, string>,
  ): Promise<void> {
    const metadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!record.secretFields.includes(k as TSecretField)) {
        metadata[k] = v;
      }
    }
    record.metadataSchema.parse(metadata);
    for (const field of record.secretFields) {
      await this.#vault.set(vaultSecretKey(record.key, field), data[field]);
    }
    await writeMetadataRecord(record.key, metadata, this.#metadataPath);
  }

  /**
   * Delete both halves of the credential bundle for `record`. Returns `true`
   * if the metadata half existed.
   */
  async delete<TMeta extends object, const TSecretField extends string>(
    record: CredentialRecord<TMeta, TSecretField>,
  ): Promise<boolean> {
    const existed = await deleteMetadataRecord(record.key, this.#metadataPath);
    for (const field of record.secretFields) {
      await this.#vault.delete(vaultSecretKey(record.key, field));
    }
    return existed;
  }
}

/** Process-wide singleton used when no custom store is needed. */
export const defaultCredentialStore = new CredentialStore();
