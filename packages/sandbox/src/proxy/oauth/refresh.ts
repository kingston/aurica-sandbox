import type { ResponseInterceptor } from '#src/config/index.js';
import { defaultCredentialStore } from '#src/credentials/credential-store.js';
import {
  defineOAuthRecord,
  type OAuthRecord,
} from '#src/credentials/oauth-record.js';

import type { AppliedMutation } from '../substitution.js';
import {
  buildSyntheticTokenResponse,
  parseTokenGrantResponse,
} from './token-body.js';

/**
 * Short-circuit handler for RFC 6749 `grant_type=refresh_token` requests
 * bound for an OAuth slot, with support for refresh-token rotation
 * (RFC 6749 §6: the authorization server MAY issue a new refresh token
 * and invalidate the previous one).
 *
 * Solves the parallel-refresh race that rotation creates: on a stale
 * access token, a guest may fire N parallel API calls; all N get 401;
 * all N independently POST the token endpoint with the same refresh
 * token; the upstream accepts the first (rotating it) and rejects the
 * rest with `invalid_grant`. Forwarding those rejections to the guest
 * would tear down the session.
 *
 * The host owns refreshes via a versioned-placeholder cache:
 *
 *   - The refresh placeholder the guest holds is `<base>:<currentCounter>`.
 *     The base is per-sandbox stable; the counter increments by 1 on
 *     every successful upstream refresh.
 *   - On each inbound refresh, the proxy extracts the trailing `:<n>`
 *     and compares to the slot's `currentCounter`:
 *       * `n < currentCounter` → a peer already refreshed and bumped
 *         the counter past us. Replay the slot's cached
 *         `lastResponseBody` verbatim. No mutex, no upstream call.
 *         Idempotent.
 *       * `n == currentCounter` → acquire the per-slot mutex. On the
 *         leader path: POST upstream with the real refresh token, mint
 *         `:<n+1>`, persist the slot (`accessToken`, `refreshToken`,
 *         `expiresAt`, `currentCounter`, `lastResponseBody`), return
 *         the synthetic response.
 *       * `n > currentCounter` → 400 `invalid_grant`. Indicates slot
 *         corruption, external mutation, or forked-sandbox state. Fail
 *         loud rather than silently forward.
 */

/**
 * Pluggable HTTP poster. Production uses `globalThis.fetch`; tests inject
 * a stub. The signature matches what mockttp's response shape needs.
 */
export type UpstreamPoster = (input: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}>;

interface InflightEntry {
  promise: Promise<RefreshOutcome>;
}

const inflight = new Map<string, InflightEntry>();

/**
 * What the proxy returns to the guest. Always a synthesized 2xx (replay
 * or fresh) or a 4xx (slot empty / future counter / upstream error).
 *
 * `mutations` describes what `runRefresh` did, for the verbose-mode
 * per-request log block. The caller (host-proxy) folds them into the
 * request's existing `appliedMutations` array via the `mutations-append`
 * verbose-logger event.
 */
export interface RefreshOutcome {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  mutations: AppliedMutation[];
}

/**
 * Options consumed by {@link runRefresh}.
 */
export interface RunRefreshOptions {
  /** Slot whose tokens this refresh targets — names the credential record. */
  interceptor: ResponseInterceptor;
  /** URL the guest was POSTing to. Used verbatim for the upstream call. */
  url: string;
  /** Guest's request headers — copied to the upstream call. */
  headers: Record<string, string | string[] | undefined>;
  /** Guest's request body, post any prior mutations. */
  bodyText: string;
  /**
   * Counter extracted from the placeholder in the guest's body, used to
   * compare against the slot's `currentCounter`. Parsed at the caller
   * level so this function stays pure-logic.
   */
  inboundCounter: number;
  /** Override the upstream poster (tests). */
  post?: UpstreamPoster;
}

/**
 * Run a refresh for one inflight guest request. Serialized per
 * `interceptor.recordKey` via {@link inflight}; concurrent callers share
 * the leader's promise.
 */
export async function runRefresh(
  opts: RunRefreshOptions,
): Promise<RefreshOutcome> {
  const recordKey = opts.interceptor.recordKey;
  const record = defineOAuthRecord(recordKey);
  // Fast path: read the slot WITHOUT the mutex. If the inbound counter
  // is already behind the cached counter AND the cached real token is
  // still fresh enough to be useful, replay immediately — no contention
  // with whichever leader is currently refreshing.
  const fastSlot = await defaultCredentialStore.read(record);
  if (fastSlot === undefined) return slotEmptyResponse(recordKey);
  if (opts.inboundCounter > fastSlot.currentCounter) {
    return futureCounterResponse(
      recordKey,
      opts.inboundCounter,
      fastSlot.currentCounter,
    );
  }
  if (
    opts.inboundCounter < fastSlot.currentCounter &&
    fastSlot.lastResponseBody !== undefined &&
    isSlotStillFresh(fastSlot)
  ) {
    return buildReplayResponse(recordKey, opts.inboundCounter, fastSlot);
  }

  // Equal counter, slot expired, or behind-with-no-replay — serialize and
  // run the leader logic. Replay can't be trusted when the real upstream
  // token has expired (handing the guest a dead token would just produce
  // an immediate 401); fall through to a real refresh instead.
  const existing = inflight.get(recordKey);
  if (existing !== undefined) return existing.promise;
  const promise = (async (): Promise<RefreshOutcome> => {
    try {
      return await runRefreshInner(opts);
    } finally {
      inflight.delete(recordKey);
    }
  })();
  inflight.set(recordKey, { promise });
  return promise;
}

async function runRefreshInner(
  opts: RunRefreshOptions,
): Promise<RefreshOutcome> {
  const recordKey = opts.interceptor.recordKey;
  const record = defineOAuthRecord(recordKey);
  // Re-read the slot under the mutex: by the time we acquired, a peer
  // leader may have finished refreshing and bumped the counter past us.
  // In that case we're a follower and the right behavior is replay —
  // again gated on slot freshness so we don't hand back a dead token.
  const slot = await defaultCredentialStore.read(record);
  if (slot === undefined) return slotEmptyResponse(recordKey);
  if (opts.inboundCounter > slot.currentCounter) {
    return futureCounterResponse(
      recordKey,
      opts.inboundCounter,
      slot.currentCounter,
    );
  }
  if (
    opts.inboundCounter < slot.currentCounter &&
    slot.lastResponseBody !== undefined &&
    isSlotStillFresh(slot)
  ) {
    return buildReplayResponse(recordKey, opts.inboundCounter, slot);
  }

  // Leader path: forward upstream with the real refresh_token, persist
  // the new bundle to the slot, return the synthesized response.
  const post = opts.post ?? defaultPoster;
  const bodyForUpstream = substituteRefreshToken(
    opts.bodyText,
    slot.refreshToken,
  );
  let upstream;
  try {
    upstream = await post({
      url: opts.url,
      headers: forwardableHeaders(opts.headers),
      body: bodyForUpstream,
    });
  } catch (err) {
    return upstreamErrorResponse(recordKey, err);
  }
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    return {
      statusCode: upstream.statusCode,
      headers: { 'content-type': 'application/json' },
      body: upstream.body,
      mutations: [
        {
          kind: 'oauth-refresh-skipped',
          target: recordKey,
          status: 'skipped',
          reason: `upstream returned ${upstream.statusCode}`,
        },
      ],
    };
  }

  let parsed;
  try {
    parsed = parseTokenGrantResponse(upstream.body);
  } catch (err) {
    return upstreamErrorResponse(recordKey, err);
  }

  const nextCounter = slot.currentCounter + 1;
  const expiresAt = Date.now() + parsed.expires_in * 1000;
  const syntheticBody = buildSyntheticTokenResponse({
    interceptor: opts.interceptor,
    counter: nextCounter,
    expiresIn: parsed.expires_in,
    scope: parsed.scope,
    extras: slot.extras,
  });
  await defaultCredentialStore.write(record, {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt,
    scopes: parsed.scope
      ? parsed.scope.split(' ').filter(Boolean)
      : [...slot.scopes],
    obtainedAt: Date.now(),
    currentCounter: nextCounter,
    lastResponseBody: syntheticBody,
    extras: slot.extras,
  });
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: syntheticBody,
    mutations: [
      {
        kind: 'oauth-refresh-leader',
        target: recordKey,
        status: 'applied',
        reason: `counter ${slot.currentCounter} → ${nextCounter}, expires in ${parsed.expires_in}s`,
      },
    ],
  };
}

function slotEmptyResponse(recordKey: string): RefreshOutcome {
  return {
    statusCode: 400,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: 'invalid_grant',
      error_description:
        'aurica-sandbox: no cached OAuth slot; run the plugin login flow inside the sandbox',
    }),
    mutations: [
      {
        kind: 'oauth-refresh-skipped',
        target: recordKey,
        status: 'skipped',
        reason: 'slot empty (not logged in)',
      },
    ],
  };
}

function futureCounterResponse(
  recordKey: string,
  inbound: number,
  current: number,
): RefreshOutcome {
  return {
    statusCode: 400,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: 'invalid_grant',
      error_description: `aurica-sandbox: refresh placeholder counter ${inbound} is ahead of slot counter ${current}; slot may have been reset`,
    }),
    mutations: [
      {
        kind: 'oauth-refresh-skipped',
        target: recordKey,
        status: 'skipped',
        reason: `inbound counter ${inbound} > slot counter ${current}`,
      },
    ],
  };
}

/**
 * Safety margin (ms) subtracted from the slot's `expiresAt` when deciding
 * whether the cached real token is still useful for replay. If a follower
 * arrives within this window of the real expiry, we'd be handing back a
 * token that's about to 401 on its first request — treat the slot as
 * stale and run the leader path instead. 60s matches common OAuth client
 * practice (network jitter + clock skew + the guest's own queueing delay).
 */
const REPLAY_FRESHNESS_MARGIN_MS = 60_000;

/**
 * Whether the slot's real upstream access token is fresh enough to
 * justify replaying the cached response body. Returning the cached body
 * when the underlying token has already expired (or is about to) would
 * just produce an immediate 401 on the guest's next API call — the
 * leader path runs instead.
 */
function isSlotStillFresh(slot: { expiresAt: number }): boolean {
  return slot.expiresAt - REPLAY_FRESHNESS_MARGIN_MS > Date.now();
}

/**
 * Build the replay response from the cached body. The cached
 * `lastResponseBody` was minted at the leader's refresh time with a
 * static `expires_in: <real>` — by the time a follower replays, that
 * value is wrong (overestimates remaining lifetime). Recompute
 * `expires_in` from the slot's absolute `expiresAt` so the guest's
 * computed `expiresAt = Date.now() + expires_in * 1000` lines up with
 * the real upstream expiry.
 *
 * Caller guarantees the slot is still fresh (see {@link isSlotStillFresh}),
 * so the recomputed `expires_in` is always positive — even allowing for
 * the safety margin we still have ≥ 60s of life.
 */
function buildReplayResponse(
  recordKey: string,
  inboundCounter: number,
  slot: Pick<
    OAuthRecord,
    'expiresAt' | 'currentCounter' | 'lastResponseBody'
  >,
): RefreshOutcome {
  if (slot.lastResponseBody === undefined) {
    // Defensive — callers already gate on this, so this branch is dead
    // outside a bug elsewhere.
    return slotEmptyResponse(recordKey);
  }
  const remainingSeconds = Math.max(
    1,
    Math.floor((slot.expiresAt - Date.now()) / 1000),
  );
  const replayMutation: AppliedMutation = {
    kind: 'oauth-refresh-replay',
    target: recordKey,
    status: 'applied',
    reason: `inbound counter ${inboundCounter} < slot counter ${slot.currentCounter}, expires in ${remainingSeconds}s`,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(slot.lastResponseBody);
  } catch {
    // The cached body is something we synthesized; if it doesn't parse
    // that's a corruption bug, but returning it raw is still safer than
    // returning nothing.
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: slot.lastResponseBody,
      mutations: [replayMutation],
    };
  }
  if (typeof parsed === 'object' && parsed !== null) {
    (parsed as Record<string, unknown>).expires_in = remainingSeconds;
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed),
    mutations: [replayMutation],
  };
}

function upstreamErrorResponse(
  recordKey: string,
  err: unknown,
): RefreshOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return {
    statusCode: 502,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: 'temporarily_unavailable',
      error_description: `aurica-sandbox: upstream refresh failed: ${message}`,
    }),
    mutations: [
      {
        kind: 'oauth-refresh-skipped',
        target: recordKey,
        status: 'skipped',
        reason: `upstream error: ${message}`,
      },
    ],
  };
}

/**
 * Replace the JSON body's `refresh_token` field with the slot's real
 * value. Falls back to a no-op when the body isn't a JSON object (the
 * upstream then rejects with whatever its own parsing error is).
 */
function substituteRefreshToken(bodyText: string, realToken: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (typeof parsed !== 'object' || parsed === null) return bodyText;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.refresh_token !== 'string') return bodyText;
  obj.refresh_token = realToken;
  return JSON.stringify(obj);
}

/**
 * Whitelist of headers the upstream POST should reuse from the guest's
 * request. Drops anything that would either break the upstream call
 * (`host`, `content-length`, `connection`) or leak guest-specific
 * routing state (`x-forwarded-for`, cookies). `content-type` carries
 * through so a form-encoded vs JSON body matches the upstream's
 * expectation.
 */
function forwardableHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'connection' ||
      lower === 'x-forwarded-for' ||
      lower === 'cookie' ||
      lower === 'accept-encoding'
    ) {
      continue;
    }
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
  }
  return out;
}

const defaultPoster: UpstreamPoster = async (input) => {
  const res = await fetch(input.url, {
    method: 'POST',
    headers: input.headers,
    body: input.body,
  });
  const body = await res.text();
  const respHeaders: Record<string, string> = {};
  for (const [key, value] of res.headers.entries()) {
    respHeaders[key] = value;
  }
  return { statusCode: res.status, headers: respHeaders, body };
};

/**
 * Test-only helper. Clears the in-flight map so a test doesn't leak refresh
 * promises into the next case. Production never calls this.
 */
export function _resetInflightForTests(): void {
  inflight.clear();
}
