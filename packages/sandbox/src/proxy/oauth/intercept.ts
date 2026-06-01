import type { ResponseInterceptor } from '#src/config/index.js';
import { defaultCredentialStore } from '#src/credentials/credential-store.js';
import { defineOAuthRecord } from '#src/credentials/oauth-record.js';

import type { AppliedMutation } from '../substitution.js';
import {
  type RefreshOutcome,
  runRefresh,
  type RunRefreshOptions,
} from './refresh.js';
import {
  buildSyntheticTokenResponse,
  parseTokenGrantResponse,
} from './token-body.js';

/**
 * Result of an interceptor invocation, ready to feed back into mockttp's
 * `beforeResponse` / `beforeRequest` API.
 *
 * `mutations` describes what the interceptor did, for the verbose-mode
 * per-request log block. The host-proxy caller folds them into the
 * request's existing `appliedMutations` array via the `mutations-append`
 * verbose-logger event so the OAuth outcomes render alongside the normal
 * `replace-header` / `remove-header` rows.
 */
export interface InterceptedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  mutations: AppliedMutation[];
}

/**
 * Apply an `oauth-token-response` interceptor to one upstream response.
 * Used on the `authorization_code` path (initial login + any other grant
 * type that flows upstream).
 *
 * On a 2xx with a parseable token-grant body, persists the real tokens to
 * the slot named by `interceptor.recordKey` (every non-RFC field rides along
 * in `extras`) and returns a rewritten body carrying the per-sandbox
 * placeholders (refresh placeholder seeded at `:0`) + the real `expires_in`.
 *
 * On any error (non-2xx upstream, malformed JSON, persist failure), returns
 * `null` so the caller forwards the upstream response unchanged — the user
 * sees the real error, the guest sees a real (failed) auth attempt, nothing
 * gets persisted.
 */
export async function applyOAuthTokenInterceptor(
  interceptor: ResponseInterceptor,
  response: {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer | string | undefined;
  },
): Promise<InterceptedResponse | null> {
  if (response.statusCode < 200 || response.statusCode >= 300) return null;

  const rawText = bodyToString(response.body);
  if (rawText === null) return null;

  let parsed;
  try {
    parsed = parseTokenGrantResponse(rawText);
  } catch {
    return null;
  }

  const record = defineOAuthRecord(interceptor.recordKey);

  // Seed currentCounter = 0 on every authorization_code grant. `lastResponseBody`
  // caches the bytes we're about to return so a guest retry of the same grant
  // replays instead of re-exchanging the auth code upstream.
  const expiresAt = Date.now() + parsed.expires_in * 1000;
  const scopes = parsed.scope ? parsed.scope.split(' ').filter(Boolean) : [];
  // Pre-read so we can carry forward prior `extras` if upstream omitted them
  // this round (some grant types echo fewer non-RFC fields than others).
  const prior = await defaultCredentialStore.read(record);
  const extras = extractExtras(parsed.raw, prior?.extras);
  const syntheticBody = buildSyntheticTokenResponse({
    interceptor,
    counter: 0,
    expiresIn: parsed.expires_in,
    scope: parsed.scope,
    extras,
  });
  try {
    await defaultCredentialStore.write(record, {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt,
      scopes,
      obtainedAt: Date.now(),
      currentCounter: 0,
      lastResponseBody: syntheticBody,
      extras,
    });
  } catch {
    return null;
  }

  // `content-length` would be wrong now — drop it and let mockttp recompute.
  // `content-encoding` is dropped because we emit raw JSON; keeping a `gzip`
  // declaration would make the guest mis-decode.
  const headers = { ...response.headers };
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'content-encoding') {
      headers[key] = undefined;
    }
  }
  return {
    statusCode: response.statusCode,
    headers,
    body: syntheticBody,
    mutations: [
      {
        kind: 'oauth-token-captured',
        target: interceptor.recordKey,
        status: 'applied',
        reason: `counter 0, expires in ${parsed.expires_in}s`,
      },
    ],
  };
}

/**
 * Pluck plugin-relevant extras from a raw upstream response. The proxy
 * doesn't know which keys are "extras" vs. plumbing, but it does need a
 * sensible map to spread onto the synthetic body so unknown fields the guest
 * may rely on round-trip. Blanket-include every field beyond the RFC core.
 *
 * Falls back to the prior slot's extras when upstream omits them (e.g. a
 * refresh response that doesn't re-include `subscriptionType` shouldn't cause
 * the guest's `.credentials.json` to lose it on retry replay).
 */
function extractExtras(
  raw: Record<string, unknown>,
  fallback: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  const rfcKeys = new Set([
    'access_token',
    'refresh_token',
    'expires_in',
    'scope',
    'token_type',
  ]);
  for (const [k, v] of Object.entries(raw)) {
    if (!rfcKeys.has(k)) extras[k] = v;
  }
  if (fallback !== undefined) {
    for (const [k, v] of Object.entries(fallback)) {
      if (!(k in extras)) extras[k] = v;
    }
  }
  return extras;
}

/**
 * Inputs the proxy passes when deciding whether to short-circuit a refresh.
 * Encapsulated so test code can drive the function without needing a
 * mockttp request handle.
 */
export interface ShortCircuitRefreshInput {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string | undefined;
  /** Override the refresh driver (tests). */
  refresher?: (opts: RunRefreshOptions) => Promise<RefreshOutcome>;
}

/**
 * Inspect a `POST /v1/oauth/token` request bound for the OAuth slot named
 * by `interceptor`. If the body declares `grant_type=refresh_token`, drive
 * the refresh via the versioned-placeholder short-circuit and return a
 * synthetic response. Otherwise (e.g. `authorization_code`) return `null`
 * so the caller forwards the request upstream normally.
 *
 * The inbound refresh placeholder is expected to be
 * `<interceptor.placeholders.refreshToken>:<n>`. The trailing `:<n>` is
 * stripped before the counter comparison; a malformed placeholder (no
 * trailing counter) is treated as `n = 0` so legacy `.credentials.json`
 * files (pre-versioning) still hit the leader path.
 */
export async function tryShortCircuitRefresh(
  interceptor: ResponseInterceptor,
  input: ShortCircuitRefreshInput,
): Promise<InterceptedResponse | null> {
  if (input.bodyText === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.grant_type !== 'refresh_token') return null;

  const inboundCounter = extractInboundCounter(
    obj.refresh_token,
    interceptor.placeholders.refreshToken,
  );
  const refresher = input.refresher ?? runRefresh;
  const result = await refresher({
    interceptor,
    url: input.url,
    headers: input.headers,
    bodyText: input.bodyText,
    inboundCounter,
  });
  return {
    statusCode: result.statusCode,
    headers: result.headers,
    body: result.body,
    mutations: result.mutations,
  };
}

/**
 * Pull the trailing `:<n>` from the guest's inbound refresh placeholder.
 * Returns `0` for any malformed or missing suffix — equivalent to
 * "guest holds the pre-versioning placeholder", which the leader path
 * can refresh normally and re-version on the next round.
 */
function extractInboundCounter(
  refreshTokenValue: unknown,
  base: string,
): number {
  if (typeof refreshTokenValue !== 'string') return 0;
  if (!refreshTokenValue.startsWith(`${base}:`)) return 0;
  const suffix = refreshTokenValue.slice(base.length + 1);
  const n = Number.parseInt(suffix, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function bodyToString(body: Buffer | string | undefined): string | null {
  if (body === undefined) return null;
  if (typeof body === 'string') return body;
  return body.toString('utf8');
}
