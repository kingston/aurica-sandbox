import { z } from 'zod';

import {
  defineCredentialRecord,
  type CredentialRecord,
} from './credential-record.js';

/**
 * Generic OAuth slot metadata, shared by every plugin whose `interceptResponse`
 * policy names an `oauth-token-response` record. RFC 6749 standardizes the
 * field set (`access_token` / `refresh_token` / `expires_in` / `scope`), so a
 * single schema covers every OAuth-backed plugin by construction:
 *
 *   - `accessToken` / `refreshToken`     → secret vault
 *   - `expiresAt`                        → real upstream expiry (epoch ms)
 *   - `scopes`                           → array form of the `scope` claim
 *   - `obtainedAt`                       → wall-clock at write time, surfaced
 *                                          by `aurica-sandbox <plugin> status`
 *   - `currentCounter` (default `0`)     → versioned-placeholder ordinal that
 *                                          drives the refresh-race short-circuit
 *   - `lastResponseBody`                 → exact bytes the proxy returned to
 *                                          the guest on the last refresh, for
 *                                          idempotent replay of followers
 *   - `extras` (default `{}`)            → non-RFC fields the upstream emits
 *                                          (e.g. Anthropic's `subscriptionType`).
 *                                          The proxy collects everything beyond
 *                                          the RFC core here; plugins surface
 *                                          what they need via `extras.<field>`.
 *
 * Defaults on `currentCounter` and `extras` keep older on-disk slot files
 * loadable after the schema gained these fields (otherwise zod would throw on
 * first read).
 */
export const oauthRecordMetadataSchema = z.object({
  expiresAt: z.number().int().nonnegative(),
  scopes: z.array(z.string()),
  obtainedAt: z.number().int().nonnegative(),
  currentCounter: z.number().int().nonnegative().default(0),
  lastResponseBody: z.string().optional(),
  extras: z.record(z.string(), z.unknown()).default({}),
});

/** Validated shape of the merged OAuth slot (metadata + secrets). */
export type OAuthRecord = z.infer<typeof oauthRecordMetadataSchema> & {
  accessToken: string;
  refreshToken: string;
};

/**
 * Build the OAuth-record descriptor for a given `recordKey`. The proxy calls
 * this at request time using the `recordKey` declared on the matching
 * `interceptResponse` policy; plugin consumers (CLI status / logout) call it
 * with their own well-known key.
 *
 * The descriptor is a plain value — calling this twice with the same key
 * returns two equivalent records that operate on the same on-disk slot.
 */
export function defineOAuthRecord(
  recordKey: string,
): CredentialRecord<
  z.infer<typeof oauthRecordMetadataSchema>,
  'accessToken' | 'refreshToken'
> {
  return defineCredentialRecord({
    key: recordKey,
    metadataSchema: oauthRecordMetadataSchema,
    secretFields: ['accessToken', 'refreshToken'] as const,
  });
}
