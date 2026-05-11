import { z } from 'zod';

import { parseCredentialSource } from '#src/credentials/index.js';

/**
 * Git committer identity mirrored into the VM as `git config --global
 * user.name` / `user.email`. Optional at the plugin level; when present,
 * BOTH fields are required so commits never carry a half-identity.
 *
 * `aurica-sandbox init` pre-fills this from the host's `~/.gitconfig` when
 * possible, but the values become part of the committed sandbox config —
 * authoritative and reproducible across machines.
 */
export const githubUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
});

/** Git committer identity — see {@link githubUserSchema}. */
export type GithubUser = z.infer<typeof githubUserSchema>;

/**
 * `tokenSource` must be a parseable credential source — any
 * `<scheme>:<name>` string the credential cache knows how to dispatch
 * (`env:<VAR>`, `gh-token`). Wrapping `parseCredentialSource` in a `.check`
 * surfaces the parser's own error message at config-load time, instead of
 * letting it throw later when the proxy tries to resolve the credential.
 *
 * Exposed so the loose project-side schema in `config/sandbox.ts` can
 * reuse the same field via `.optional()`.
 */
export const githubTokenSourceSchema = z
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
 * Raw github plugin shape. Exposed (alongside
 * {@link GH_TOKEN_API_INCOMPATIBLE_MESSAGE}) so the loose project-side
 * schema in `config/sandbox.ts` can rebuild a variant with `username` /
 * `tokenSource` optional and re-apply the same cross-field invariant —
 * without going through `.extend()`, which Zod 4 rejects on refined
 * schemas.
 */
export const githubPluginShape = {
  type: z.literal('github'),
  username: z.string().min(1),
  user: githubUserSchema.optional(),
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
  tokenSource: githubTokenSourceSchema,
  api: z.boolean().optional(),
};

/**
 * Error message for the `gh-token` + `api: true` cross-field invariant.
 * Exposed so the loose project-side schema can emit the same message from
 * its own `.check()`.
 */
export const GH_TOKEN_API_INCOMPATIBLE_MESSAGE =
  "github plugin: `tokenSource: gh-token` cannot be combined with `api: true`. The gh CLI's token usually lacks the scopes for full API access — configure a fine-grained PAT via `tokenSource: env:<VAR>` instead.";

/**
 * GitHub auth plugin. `repositories` lists the `<owner>/<repo>` pairs the
 * token should be attached to. Path-scoping at the proxy + per-repo entries
 * in `~/.git-credentials` (with `credential.useHttpPath = true`) together
 * ensure the token is only sent to those specific repos.
 *
 * Each repo defaults to allowing fetch + push over git smart-HTTP; setting
 * `readOnly: true` drops `git-receive-pack` so push is denied at the proxy.
 *
 * Every listed repository is cloned into `/workspaces/<repo>` inside the
 * VM during init. The first entry in `repositories[]` is treated as the
 * **primary** repo: the project-level init hook (`setup-project.sh`) runs
 * with its cwd set to the primary repo path, and `AURICA_PROJECT_DIR` is
 * written into `/etc/environment` so every PAM-launched shell sees it.
 *
 * `api` (plugin-level, default `false`) controls whether the configured
 * token is attached to `api.github.com` traffic. `api.github.com` is always
 * reachable through the proxy — the flag only governs authentication:
 *
 * - `api: true` attaches the token to every request, opening the
 *   token-scoped API surface (including `/graphql`). This is a deliberate
 *   bypass of repo scoping for the API — GraphQL POSTs encode repo identity
 *   in the request body rather than the URL, so the proxy can't constrain
 *   them per-repo; the token is trusted to enforce that. Disallowed in
 *   combination with `tokenSource: gh-token`, since the gh CLI's token
 *   typically lacks the scopes that make this useful.
 * - `api: false` (the default) lets requests through unauthenticated, so
 *   tools that only need public endpoints (e.g. mise resolving release
 *   versions) keep working without granting the token broad API scope.
 *   Subject to GitHub's anonymous rate limit (60/hr/IP).
 *
 * `username` is the credential username embedded in `~/.git-credentials`
 * URLs (`https://<username>:<token>@github.com/...`). For GitHub PATs and
 * app installation tokens the conventional value is `x-access-token`, but
 * any non-empty string is accepted.
 *
 * `user` (optional) sets the VM's global git committer identity. See
 * {@link githubUserSchema}.
 *
 * `tokenSource` is a credential-source string parseable by
 * `parseCredentialSource`. Supported schemes: `env:<VAR>` and `gh-token`.
 */
export const githubPluginSchema = z.object(githubPluginShape).check((ctx) => {
  // Skips when `tokenSource` is undefined — the loose project-side schema
  // may defer it to the user layer, and the strict re-parse after merging
  // catches the merged-bad case.
  if (ctx.value.tokenSource === 'gh-token' && ctx.value.api === true) {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message: GH_TOKEN_API_INCOMPATIBLE_MESSAGE,
    });
  }
});

export type GithubPlugin = z.infer<typeof githubPluginSchema>;
