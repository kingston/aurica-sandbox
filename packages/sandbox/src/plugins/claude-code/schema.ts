import { z } from 'zod';

/**
 * Claude Code plugin project config.
 *
 * `authMode` selects which header Claude Code uses and which credential
 * source the default `tokenSource` resolves from:
 *
 * - `api-key`      — `x-api-key`, defaults to `env:ANTHROPIC_API_KEY`.
 *                    Use for direct Anthropic API access. Anthropic
 *                    API keys are opaque, so a placeholder substituted
 *                    on the wire round-trips cleanly.
 * - `oauth-token`  — `Authorization: Bearer`, defaults to
 *                    `env:CLAUDE_CODE_OAUTH_TOKEN`. Use for the
 *                    long-lived (1-year) OAuth token from
 *                    `claude setup-token`.
 * - `subscription` — `Authorization: Bearer`, defaults to
 *                    `vault:claude-code:oauth`. Use for the Anthropic
 *                    subscription tier (Pro / Max / Team / Enterprise).
 *                    Login is driven by `claude /login` inside the sandbox
 *                    VM; the proxy intercepts the resulting token-endpoint
 *                    response and persists tokens to the host store.
 *
 * `tokenSource` overrides the default. It's a credential-source string
 * parseable by `parseCredentialSource` (e.g. `env:MY_VAR`).
 */
export const claudeCodeProjectConfigSchema = z.object({
  authMode: z.enum(['api-key', 'oauth-token', 'subscription']),
  tokenSource: z.string().min(1).optional(),
});

/** Claude Code project config — see {@link claudeCodeProjectConfigSchema}. */
export type ClaudeCodeProjectConfig = z.infer<
  typeof claudeCodeProjectConfigSchema
>;
