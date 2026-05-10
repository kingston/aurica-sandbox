import { z } from 'zod';

/**
 * Per-capability permission level. Mirrors GitHub's fine-grained PAT
 * taxonomy. Capabilities compose — a repo with `{ contents: 'read',
 * pullRequests: 'write' }` gets the union of those endpoints.
 *
 * `read` allows the safe (mostly GET) subset; `write` is `read` plus the
 * mutating methods. See `permissions.ts` for the exact path/method
 * sets each capability resolves to.
 */
export const githubPermissionLevelSchema = z.enum(['read', 'write']);

/** Permission level — see {@link githubPermissionLevelSchema}. */
export type GithubPermissionLevel = z.infer<typeof githubPermissionLevelSchema>;

/**
 * Set of GitHub capabilities granted to a repo. Omitting a key means the
 * capability isn't granted (no policy emitted for its endpoints).
 *
 * If the entire `permissions` field is omitted on a repo, the expander
 * falls back to the legacy "any path under the repo" coarse policy —
 * preserves today's behaviour for configs that haven't opted in.
 *
 * `permissions: {}` (empty object) is meaningful: it grants nothing,
 * emitting no policies. The host stays allowlisted, so requests pass
 * through unauthenticated and GitHub 401s anything that needs a token.
 */
export const githubPermissionsSchema = z.object({
  contents: githubPermissionLevelSchema.optional(),
  pullRequests: githubPermissionLevelSchema.optional(),
  issues: githubPermissionLevelSchema.optional(),
  actions: githubPermissionLevelSchema.optional(),
});

/** Per-repo capability set — see {@link githubPermissionsSchema}. */
export type GithubPermissions = z.infer<typeof githubPermissionsSchema>;

/**
 * GitHub auth plugin. `repositories` lists the `<owner>/<repo>` pairs the
 * token should be attached to. Path-scoping at the proxy + per-repo entries
 * in `~/.git-credentials` (with `credential.useHttpPath = true`) together
 * ensure the token is only sent to those specific repos.
 *
 * Each repo can carry an optional `permissions` field that scopes the
 * token further by HTTP method and API endpoint, modelled on GitHub's
 * fine-grained PAT permission taxonomy. When omitted, the expander emits
 * today's coarse policies (token attached to anything under the repo
 * path).
 *
 * `username` is the credential username embedded in `~/.git-credentials`
 * URLs (`https://<username>:<token>@github.com/...`). For GitHub PATs and
 * app installation tokens the conventional value is `x-access-token`, but
 * any non-empty string is accepted.
 *
 * `token` is a credential-source string parseable by `parseCredentialSource`
 * (v1: only `env:VAR`).
 */
export const githubPluginSchema = z.object({
  type: z.literal('github'),
  username: z.string().min(1),
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
        permissions: githubPermissionsSchema.optional(),
      }),
    )
    .min(1),
  token: z.string().min(1),
});

export type GithubPlugin = z.infer<typeof githubPluginSchema>;
