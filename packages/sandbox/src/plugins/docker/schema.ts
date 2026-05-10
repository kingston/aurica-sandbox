import { z } from 'zod';

/**
 * Docker plugin. Installs Docker Engine pre-lockdown and adds the default
 * user to the `docker` group. Contributes proxy domains for the apt repo
 * and Docker Hub so post-lockdown `docker pull` works.
 */
export const dockerPluginSchema = z.object({
  type: z.literal('docker'),
});

export type DockerPlugin = z.infer<typeof dockerPluginSchema>;
