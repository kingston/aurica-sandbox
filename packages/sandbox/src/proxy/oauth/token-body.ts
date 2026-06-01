import { z } from 'zod';

import type { ResponseInterceptor } from '#src/config/index.js';

/**
 * Shape of an RFC 6749 token-grant success response that the proxy
 * knows how to capture. Unknown extra fields (e.g. Anthropic's
 * `organization` / `account` / `subscriptionType`) round-trip through
 * the rewrite verbatim — they live under `raw` for the plugin handler
 * to mine.
 *
 * `looseObject` (Zod 4) preserves unknown fields under `.raw`-style
 * access via the same shape, so callers can spread them onto the
 * synthetic response without the proxy needing to enumerate every
 * upstream extension.
 */
const tokenGrantSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

/**
 * Validated upstream response body. `raw` is the parsed JSON (with
 * unknown fields preserved) the plugin handler narrows when capturing
 * non-RFC fields like Anthropic's `subscriptionType`.
 */
export interface ParsedTokenGrant {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  raw: Record<string, unknown>;
}

/**
 * Parse + validate an upstream token-grant response. Throws when the
 * body isn't JSON or is missing required RFC fields.
 */
export function parseTokenGrantResponse(rawText: string): ParsedTokenGrant {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('oauth-token-body: upstream returned non-JSON');
  }
  const result = tokenGrantSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `oauth-token-body: upstream body missing required token fields: ${result.error.message}`,
    );
  }
  const data = result.data;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    ...(data.scope !== undefined ? { scope: data.scope } : {}),
    raw: parsed as Record<string, unknown>,
  };
}

/**
 * Inputs to {@link buildSyntheticTokenResponse}. The proxy supplies the
 * RFC-shaped fields it derived (counter, expiry, scope); the handler's
 * `extras` carry plugin-specific extensions that must round-trip back
 * to the guest unchanged.
 */
export interface BuildSyntheticOptions {
  interceptor: ResponseInterceptor;
  /** The counter to embed in the refresh placeholder (`<base>:<counter>`). */
  counter: number;
  /** Real upstream `expires_in` (seconds). */
  expiresIn: number;
  /** Real upstream scope string, or `undefined` to omit the field. */
  scope: string | undefined;
  /** Plugin-specific fields (e.g. `subscriptionType`) to spread onto the body. */
  extras: Record<string, unknown>;
}

/**
 * Build the JSON body the proxy returns to the guest after a successful
 * token grant. Same shape for `authorization_code` (counter = 0) and
 * `refresh_token` (counter = previous + 1) — followers in a parallel
 * burst replay the exact bytes built here, so determinism matters.
 */
export function buildSyntheticTokenResponse(
  opts: BuildSyntheticOptions,
): string {
  const body: Record<string, unknown> = {
    ...opts.extras,
    access_token: opts.interceptor.placeholders.accessToken,
    refresh_token: `${opts.interceptor.placeholders.refreshToken}:${opts.counter}`,
    expires_in: opts.expiresIn,
    token_type: 'Bearer',
  };
  if (opts.scope !== undefined) body.scope = opts.scope;
  return JSON.stringify(body);
}
