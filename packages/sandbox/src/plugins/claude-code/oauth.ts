import { defineOAuthRecord } from '#src/credentials/oauth-record.js';

/**
 * Record key the Claude Code subscription OAuth slot lives under. Shared
 * across all sandboxes today; a future multi-sandbox iteration would extend
 * to `claude-code:oauth:<sandbox-id>`.
 *
 * The same key appears verbatim on the `interceptResponse` policy this
 * plugin emits at `initialize` time — that's how the proxy's
 * `oauth-token-response` handler routes captured tokens back to this slot.
 */
export const CLAUDE_OAUTH_RECORD_KEY = 'claude-code:oauth';

/**
 * Credential record descriptor for the Claude OAuth slot. Wraps the generic
 * {@link defineOAuthRecord} factory so consumers (CLI status / logout,
 * `claude-oauth` credential provider) operate on the same slot the proxy's
 * `oauth-token-response` interceptor writes into.
 *
 * The metadata schema is the generic OAuth shape ({@link oauthRecordMetadataSchema}):
 * `expiresAt`, `scopes`, `obtainedAt`, `currentCounter`, `lastResponseBody`,
 * and an `extras` blob. Anything Anthropic-specific the upstream emits
 * (e.g. `subscriptionType`) rides along in `extras` — captured automatically
 * by the proxy's intercept code, surfaced to callers via
 * `slot.extras.subscriptionType`.
 */
export const claudeRecord = defineOAuthRecord(CLAUDE_OAUTH_RECORD_KEY);

/**
 * Raised when the slot is missing entirely (no `claude /login` has run
 * for this sandbox yet, or `aurica-sandbox claude logout` cleared it).
 * The `claude-oauth` provider surfaces this verbatim so the proxy can
 * turn it into a 401 the user sees in `claude`'s stderr.
 */
export class ClaudeNotLoggedInError extends Error {
  constructor() {
    super(
      'claude-oauth: no Claude subscription token cached. Run `claude /login` inside your sandbox VM to authenticate.',
    );
    this.name = 'ClaudeNotLoggedInError';
  }
}
