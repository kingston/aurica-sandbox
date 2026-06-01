import { z } from 'zod';

import type { CredentialRecord } from '#src/credentials/credential-record.js';
import { defaultCredentialStore } from '#src/credentials/credential-store.js';
import { createPluginCredentialRecordFactory } from '#src/credentials/plugin-credential-record.js';

/**
 * Per-upstream MCP credentials, split across two slots so a token refresh
 * (frequent) doesn't have to merge with the client registration blob
 * (one-time). Both halves are opaque from our side — the MCP SDK
 * validates `OAuthClientInformationFull` and `OAuthTokens` on its way
 * in and out — so the metadata side is empty and the actual payload
 * lives in the secret store as a JSON-stringified blob.
 *
 * Keys:
 *   `mcp:upstream:<name>:client` → `OAuthClientInformationFull` JSON
 *   `mcp:upstream:<name>:tokens` → `OAuthTokens` JSON
 *
 * Routing both through the secret store mirrors the Claude-side split:
 * anything resembling a credential lives in `secrets.json`, so a future
 * keychain swap-in covers everything in one move.
 */
const opaqueMetadataSchema = z.object({});
const defineRecord = createPluginCredentialRecordFactory('mcp');

/** Opaque record type for both client and tokens halves. */
type OpaqueRecord = CredentialRecord<Record<string, never>, 'blob'>;

function clientRecord(upstream: string): OpaqueRecord {
  return defineRecord(`upstream:${upstream}:client`, {
    metadataSchema: opaqueMetadataSchema,
    secretFields: ['blob'],
  });
}

function tokensRecord(upstream: string): OpaqueRecord {
  return defineRecord(`upstream:${upstream}:tokens`, {
    metadataSchema: opaqueMetadataSchema,
    secretFields: ['blob'],
  });
}

/**
 * Public per-upstream view of the persisted state, recombining both
 * underlying slots into the legacy shape MCP callers expect.
 */
export interface UpstreamRecord {
  clientInformation?: unknown;
  tokens?: unknown;
}

function parse(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(value) as unknown;
}

/**
 * Read the merged client-info + tokens for `upstream`. Returns
 * `undefined` when neither half exists; returns a partial object when
 * one half exists and the other doesn't (e.g. registered but not yet
 * logged in).
 */
export async function readUpstreamRecord(
  upstream: string,
): Promise<UpstreamRecord | undefined> {
  const [client, tokens] = await Promise.all([
    defaultCredentialStore.read(clientRecord(upstream)),
    defaultCredentialStore.read(tokensRecord(upstream)),
  ]);
  if (!client && !tokens) return undefined;
  const out: UpstreamRecord = {};
  if (client) out.clientInformation = parse(client.blob);
  if (tokens) out.tokens = parse(tokens.blob);
  return out;
}

/**
 * Overwrite both halves of `upstream` to match `record`. Fields not
 * present on `record` are cleared. Used by tests and by callers that
 * want to write both halves in one go; the file-oauth-provider
 * prefers {@link writeUpstreamClient} / {@link writeUpstreamTokens}
 * to avoid clobbering whichever half it isn't touching.
 */
export async function writeUpstreamRecord(
  upstream: string,
  record: UpstreamRecord,
): Promise<void> {
  await (record.clientInformation === undefined
    ? defaultCredentialStore.delete(clientRecord(upstream))
    : defaultCredentialStore.write(clientRecord(upstream), {
        blob: JSON.stringify(record.clientInformation),
      }));
  await (record.tokens === undefined
    ? defaultCredentialStore.delete(tokensRecord(upstream))
    : defaultCredentialStore.write(tokensRecord(upstream), {
        blob: JSON.stringify(record.tokens),
      }));
}

/** Write just the client-information half. */
export async function writeUpstreamClient(
  upstream: string,
  clientInformation: unknown,
): Promise<void> {
  await defaultCredentialStore.write(clientRecord(upstream), {
    blob: JSON.stringify(clientInformation),
  });
}

/** Write just the tokens half. */
export async function writeUpstreamTokens(
  upstream: string,
  tokens: unknown,
): Promise<void> {
  await defaultCredentialStore.write(tokensRecord(upstream), {
    blob: JSON.stringify(tokens),
  });
}

/** Delete just the client-information half. */
export async function deleteUpstreamClient(upstream: string): Promise<boolean> {
  return defaultCredentialStore.delete(clientRecord(upstream));
}

/** Delete just the tokens half. */
export async function deleteUpstreamTokens(upstream: string): Promise<boolean> {
  return defaultCredentialStore.delete(tokensRecord(upstream));
}

/**
 * Delete both halves for `upstream`. Returns `true` if either half
 * existed; matches the legacy `deleteUpstreamRecord` semantics.
 */
export async function deleteUpstreamRecord(upstream: string): Promise<boolean> {
  const [clientExisted, tokensExisted] = await Promise.all([
    deleteUpstreamClient(upstream),
    deleteUpstreamTokens(upstream),
  ]);
  return clientExisted || tokensExisted;
}
