import { z } from 'zod';

import { parseCredentialSource } from '#src/credentials/index.js';

/**
 * Git committer identity mirrored into the VM as `git config --global
 * user.name` / `user.email`. Optional at the plugin level; when present,
 * BOTH fields are required so commits never carry a half-identity.
 *
 * Usually left unset: it's a per-user value, so the github plugin reads the
 * host `~/.gitconfig` at create time when neither this field nor the
 * user-level `defaultUser` is set. Set it explicitly only to pin a specific
 * identity into the committed config.
 */
export const githubUserIdentitySchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
});

/** Git committer identity — see {@link githubUserIdentitySchema}. */
export type GithubUserIdentity = z.infer<typeof githubUserIdentitySchema>;

/**
 * Credential-source string parseable by `parseCredentialSource` (e.g.
 * `env:<VAR>`, `gh-token`). The `.check()` surfaces the parser's own error
 * message at config-load time rather than letting it throw later when the
 * proxy tries to resolve the credential.
 */
const tokenSourceSchema = z
  .string()
  .min(1)
  .check((ctx) => {
    try {
      parseCredentialSource(ctx.value);
    } catch (err) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

/**
 * Error message for the `gh-token` + `api: true` cross-field invariant. The
 * gh CLI's token usually lacks the scopes for full API access, so combining
 * the two would create a sandbox where the API surface is opened but
 * authenticated with a token that can't use most of it.
 */
export const GH_TOKEN_API_INCOMPATIBLE_MESSAGE =
  "github plugin: `tokenSource: gh-token` cannot be combined with `api: true`. The gh CLI's token usually lacks the scopes for full API access — configure a fine-grained PAT via `tokenSource: env:<VAR>` instead.";

/**
 * Project-level github plugin config. `username` and `tokenSource` are
 * optional: a user-level config block may supply `defaultUsername` /
 * `defaultTokenSource` as fallbacks. Resolution happens in the github
 * plugin's `initialize` — if neither layer provides a value, `initialize`
 * throws with a message that names the missing field.
 *
 * `repositories` is required and must be non-empty so a project's
 * `sandbox.json` always names exactly which repos the plugin should clone +
 * scope auth to. `api` (default false) controls whether the configured
 * token is attached to `api.github.com` traffic; `api: true` plus
 * `tokenSource: gh-token` is rejected here, since user-level
 * `defaultTokenSource` is never `gh-token` (env-only).
 */
export const githubProjectConfigSchema = z
  .object({
    username: z.string().min(1).optional(),
    user: githubUserIdentitySchema.optional(),
    repositories: z
      .array(
        z.object({
          name: z
            .string()
            .min(1)
            .regex(
              /^[^/\s]+\/[^/\s]+$/,
              'expected "<owner>/<repo>" with no slashes inside owner or repo',
            ),
          readOnly: z.boolean().optional(),
        }),
      )
      .min(1),
    tokenSource: tokenSourceSchema.optional(),
    api: z.boolean().optional(),
  })
  .check((ctx) => {
    if (ctx.value.tokenSource === 'gh-token' && ctx.value.api === true) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: GH_TOKEN_API_INCOMPATIBLE_MESSAGE,
      });
    }
  });

/** Github project config — see {@link githubProjectConfigSchema}. */
export type GithubProjectConfig = z.infer<typeof githubProjectConfigSchema>;

/**
 * User-level github defaults. All fields are optional. `defaultTokenSource`
 * is the env-var-resolved credential the github plugin falls back to when
 * the project's `tokenSource` is omitted; `defaultUsername` is the
 * git-credentials username (conventionally `x-access-token` for GitHub
 * PATs); `defaultUser` is the global git committer identity.
 *
 * The user-level layer never carries `gh-token` semantics — the gh CLI's
 * token is implicit and project-bound by design, so users who want
 * gh-token must declare it explicitly in `sandbox.json`. The schema
 * therefore reuses the same `tokenSource` validator but the
 * `gh-token`/`api: true` invariant is moot here (no `api` field on the
 * user side).
 */
export const githubUserConfigSchema = z.object({
  defaultUsername: z.string().min(1).optional(),
  defaultTokenSource: tokenSourceSchema.optional(),
  defaultUser: githubUserIdentitySchema.optional(),
});

/** Github user-level defaults — see {@link githubUserConfigSchema}. */
export type GithubUserConfig = z.infer<typeof githubUserConfigSchema>;
