import { z } from 'zod';

import { secretsFilePath } from '#src/config/paths.js';

import { readJsonFile, withJsonFile } from '../utils/json-file.js';

/**
 * Pluggable backing vault for short secret strings (OAuth tokens, opaque
 * SDK token blobs serialized as JSON). The `defineCredentialRecord` factory
 * in {@link './credential-record.js'} routes secret-field values through
 * this interface so a future {@link KeychainSecretVault} (macOS Keychain /
 * Linux Secret Service / Windows DPAPI) can swap in as a one-line wiring
 * change.
 *
 * Keys are namespaced strings shaped as `<record-key>:<field>`, e.g.
 * `claude-code:oauth:accessToken`. Implementations must treat keys as
 * opaque — don't parse them.
 */
export interface SecretVault {
  /** Return the stored secret, or `undefined` if no value is set. */
  get(key: string): Promise<string | undefined>;
  /** Replace (or create) the secret for `key`. */
  set(key: string, value: string): Promise<void>;
  /** Remove `key`. Returns `true` if a value existed, `false` otherwise. */
  delete(key: string): Promise<boolean>;
}

/**
 * On-disk shape of the file-backed secret vault. Mirrors the metadata
 * file's `{ version, records }` shape so a swap to a different vault
 * (e.g. keychain) only changes where the strings live, not what they mean.
 */
const secretsFileSchema = z.object({
  version: z.literal(1).default(1),
  secrets: z.record(z.string().min(1), z.string()).default({}),
});

type SecretsFile = z.infer<typeof secretsFileSchema>;

const emptyFile: SecretsFile = { version: 1, secrets: {} };

/**
 * Default file-backed implementation of {@link SecretVault}. Writes
 * secrets to `~/.aurica/sandbox/secrets.json` (mode 0600) via the same
 * lock + atomic-write helpers as the metadata store, so a concurrent
 * `mcp login` and `claude /login` (intercepted) can't race each other.
 *
 * Disk-encryption posture is the same as the previous single-file
 * design (filesystem-level only); the win is logical separation, which
 * unblocks the keychain swap.
 */
export class FileSecretVault implements SecretVault {
  readonly #filePathOverride: string | undefined;

  /**
   * `filePath` is captured eagerly when explicitly passed so tests can
   * pin a tmpfile. When omitted, `secretsFilePath()` is resolved lazily
   * on each call so a process-wide `AURICA_HOME` env-var swap (the
   * standard test isolation knob) takes effect even though the
   * {@link defaultSecretVault} singleton is constructed at module load.
   */
  constructor(filePath?: string) {
    this.#filePathOverride = filePath;
  }

  #filePath(): string {
    return this.#filePathOverride ?? secretsFilePath();
  }

  async get(key: string): Promise<string | undefined> {
    const file = await readJsonFile(
      this.#filePath(),
      secretsFileSchema,
      emptyFile,
    );
    return file.secrets[key];
  }

  async set(key: string, value: string): Promise<void> {
    await withJsonFile(
      this.#filePath(),
      secretsFileSchema,
      emptyFile,
      (current) => {
        current.secrets[key] = value;
        return current;
      },
    );
  }

  async delete(key: string): Promise<boolean> {
    let existed = false;
    await withJsonFile(
      this.#filePath(),
      secretsFileSchema,
      emptyFile,
      (current) => {
        existed = key in current.secrets;
        current.secrets = Object.fromEntries(
          Object.entries(current.secrets).filter(([k]) => k !== key),
        );
        return current;
      },
    );
    return existed;
  }
}

/**
 * Process-wide singleton. Tests inject an in-memory fake via
 * {@link CredentialStoreOptions.vault}.
 */
export const defaultSecretVault: SecretVault = new FileSecretVault();
