import { z } from 'zod';

/**
 * Claude Code plugin project config.
 *
 * `authMode` selects which header Claude Code uses and which env var the
 * default `tokenSource` resolves from:
 *
 * - `api-key`     — `x-api-key`, defaults to `env:ANTHROPIC_API_KEY`. Use
 *                   this for direct Anthropic API access. Anthropic API keys
 *                   are opaque, so a placeholder substituted on the wire
 *                   round-trips cleanly.
 * - `oauth-token` — `Authorization: Bearer`, defaults to
 *                   `env:CLAUDE_CODE_OAUTH_TOKEN`. Use this for the
 *                   long-lived (1-year) OAuth token from `claude
 *                   setup-token`. Subscription-flavoured short-lived tokens
 *                   from `claude /login` are NOT supported here — they
 *                   expire daily and would need a refreshing credential
 *                   provider on the host (see `claude-oauth` follow-up).
 *
 * `tokenSource` overrides the default. It's a credential-source string
 * parseable by `parseCredentialSource` (e.g. `env:MY_VAR`).
 */
export const claudeCodeProjectConfigSchema = z.object({
  authMode: z.enum(['api-key', 'oauth-token']),
  tokenSource: z.string().min(1).optional(),
});

/** Claude Code project config — see {@link claudeCodeProjectConfigSchema}. */
export type ClaudeCodeProjectConfig = z.infer<
  typeof claudeCodeProjectConfigSchema
>;
