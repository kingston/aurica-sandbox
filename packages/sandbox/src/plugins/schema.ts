import { z } from 'zod';

/**
 * GitHub auth plugin. `repositories` lists the `<owner>/<repo>` pairs the
 * token should be attached to. Path-scoping at the proxy + per-repo entries
 * in `~/.git-credentials` (with `credential.useHttpPath = true`) together
 * ensure the token is only sent to those specific repos.
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
      }),
    )
    .min(1),
  token: z.string().min(1),
});

export type GithubPlugin = z.infer<typeof githubPluginSchema>;

/**
 * Docker plugin. Installs Docker Engine pre-lockdown and adds the default
 * user to the `docker` group. Contributes proxy domains for the apt repo
 * and Docker Hub so post-lockdown `docker pull` works.
 */
export const dockerPluginSchema = z.object({
  type: z.literal('docker'),
});

export type DockerPlugin = z.infer<typeof dockerPluginSchema>;

/**
 * mise plugin. Installs mise into the default user's `~/.local/bin`
 * pre-lockdown. Contributes proxy domains for `mise.run` and common
 * language CDNs so `mise install <tool>` works post-lockdown.
 */
export const misePluginSchema = z.object({
  type: z.literal('mise'),
});

export type MisePlugin = z.infer<typeof misePluginSchema>;

/** Discriminated union over all plugin providers. */
export const pluginSchema = z.discriminatedUnion('type', [
  githubPluginSchema,
  dockerPluginSchema,
  misePluginSchema,
]);

export type Plugin = z.infer<typeof pluginSchema>;
