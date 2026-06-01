import type { z } from 'zod';

/**
 * Pure descriptor for a credential record whose fields split across the
 * metadata store and the secret vault.
 */
export interface CredentialRecord<
  TMeta extends object,
  TSecretField extends string,
> {
  /**
   * Namespace key for this record (e.g. `'claude-code:oauth'`). Used as
   * the metadata store key and as the prefix for vault secret keys
   * (`<key>:<field>`). Surfaced so callers that reference the record by
   * name — e.g. a proxy policy's `recordKey` field — stay in sync with
   * the definition.
   */
  readonly key: string;
  /** Zod schema that validates the non-secret half on every read. */
  readonly metadataSchema: z.ZodType<TMeta>;
  /** Names of fields whose values go to the secret vault. */
  readonly secretFields: readonly TSecretField[];
}

/**
 * Options for {@link defineCredentialRecord}.
 *
 * `metadataSchema` validates the non-secret half on every read. Use
 * `z.object({})` for records that are entirely secret.
 *
 * `secretFields` enumerates the field names whose values go to the
 * secret vault. Use the `const` generic modifier at the call site
 * (inferred automatically when passing an inline array literal).
 */
export interface DefineCredentialRecordOptions<
  TMeta extends object,
  TSecretField extends string,
> {
  key: string;
  metadataSchema: z.ZodType<TMeta>;
  secretFields: readonly TSecretField[];
}

/**
 * Build a typed credential record descriptor.
 *
 * The descriptor carries the key, schema, and secret-field list. Pass it to
 * a {@link './credential-store.js' | CredentialStore} (`defaultCredentialStore`
 * for production) to perform actual I/O.
 */
export function defineCredentialRecord<
  TMeta extends object,
  const TSecretField extends string,
>(
  opts: DefineCredentialRecordOptions<TMeta, TSecretField>,
): CredentialRecord<TMeta, TSecretField> {
  return {
    key: opts.key,
    metadataSchema: opts.metadataSchema,
    secretFields: opts.secretFields,
  };
}
