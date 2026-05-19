import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { logger } from '#src/logger.js';

import {
  deleteUpstreamSlot,
  readUpstreamSlot,
  withCredentials,
} from './credentials-store.js';

/**
 * Options for {@link FileOAuthProvider}.
 *
 * `upstream` is the key in `credentials.json`'s `upstreams` block — one
 * provider instance is scoped to exactly one upstream.
 *
 * `redirectUrl` is the host-side OAuth callback URL handed to the
 * authorization server. The login command stands up a one-shot localhost
 * HTTP server on this URL and feeds the resulting code back to the SDK.
 *
 * `clientMetadata` is sent to the upstream during Dynamic Client
 * Registration (when no `clientInformation` is cached) and identifies
 * this MCP client.
 *
 * `onAuthorizationUrl` is invoked when the SDK needs the user agent to
 * visit an authorization URL. In `mcp login` we open the URL in the
 * host's browser via `open`; in tests we capture it for assertion.
 *
 * `credentialsPath` overrides the default credentials.json path (used
 * exclusively by tests).
 */
export interface FileOAuthProviderOptions {
  upstream: string;
  redirectUrl: string;
  clientMetadata: OAuthClientMetadata;
  onAuthorizationUrl: (url: URL) => void | Promise<void>;
  credentialsPath?: string | undefined;
}

/**
 * File-backed implementation of the MCP SDK's `OAuthClientProvider`.
 *
 * Persists `clientInformation` (set automatically by the SDK after
 * Dynamic Client Registration per RFC 7591) and `tokens` (set by the
 * SDK after the authorization-code exchange and refreshed transparently
 * on every subsequent refresh) into `credentials.json` under the
 * `upstreams.<name>` slot.
 *
 * The PKCE `codeVerifier` is intentionally in-memory only — it is
 * single-use, scoped to one login attempt, and never needs to survive a
 * process restart. Persisting it would expand the attack surface for
 * essentially zero benefit.
 *
 * Each instance is scoped to exactly one upstream so concurrent logins
 * to different upstreams cannot trample each other's verifier state.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  readonly #upstream: string;
  readonly #redirectUrl: string;
  readonly #clientMetadata: OAuthClientMetadata;
  readonly #onAuthorizationUrl: (url: URL) => void | Promise<void>;
  readonly #credentialsPath: string | undefined;
  #codeVerifier: string | undefined;

  constructor(opts: FileOAuthProviderOptions) {
    this.#upstream = opts.upstream;
    this.#redirectUrl = opts.redirectUrl;
    this.#clientMetadata = opts.clientMetadata;
    this.#onAuthorizationUrl = opts.onAuthorizationUrl;
    this.#credentialsPath = opts.credentialsPath;
  }

  get redirectUrl(): string {
    return this.#redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.#clientMetadata;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const slot = await readUpstreamSlot(this.#upstream, this.#credentialsPath);
    // Stored as `unknown` (we trust the SDK to validate when it reads).
    // Returning `undefined` triggers Dynamic Client Registration.
    return slot?.clientInformation as OAuthClientInformationMixed | undefined;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await withCredentials((file) => {
      const slot = file.upstreams[this.#upstream] ?? {};
      slot.clientInformation = clientInformation;
      file.upstreams[this.#upstream] = slot;
    }, this.#credentialsPath);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const slot = await readUpstreamSlot(this.#upstream, this.#credentialsPath);
    return slot?.tokens as OAuthTokens | undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await withCredentials((file) => {
      const slot = file.upstreams[this.#upstream] ?? {};
      slot.tokens = tokens;
      file.upstreams[this.#upstream] = slot;
    }, this.#credentialsPath);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.#onAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.#codeVerifier === undefined) {
      throw new Error(
        `MCP upstream ${this.#upstream}: code verifier not set (saveCodeVerifier must be called before codeVerifier)`,
      );
    }
    return this.#codeVerifier;
  }

  /**
   * SDK-driven hook the transport invokes on repeated auth failures.
   * Honoring `'all'`, `'tokens'`, and `'client'` keeps a stale cached
   * registration from indefinitely failing the next `mcp login` — the
   * next attempt will go through DCR again from a clean slate.
   *
   * The PKCE verifier already lives only in memory; nothing to do for
   * `'verifier'`. Discovery state isn't persisted either, so `'discovery'`
   * is a no-op.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    logger.debug(`MCP upstream ${this.#upstream}: invalidate ${scope}`);
    if (scope === 'all') {
      await deleteUpstreamSlot(this.#upstream, this.#credentialsPath);
      return;
    }
    if (scope === 'verifier') {
      this.#codeVerifier = undefined;
      return;
    }
    if (scope === 'tokens' || scope === 'client') {
      await withCredentials((file) => {
        const slot = file.upstreams[this.#upstream];
        if (!slot) return;
        if (scope === 'tokens') slot.tokens = undefined;
        else slot.clientInformation = undefined;
      }, this.#credentialsPath);
    }
  }
}
