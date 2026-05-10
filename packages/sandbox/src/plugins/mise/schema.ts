import { z } from 'zod';

/**
 * mise plugin. Installs mise into the default user's `~/.local/bin`
 * pre-lockdown. Contributes proxy domains for `mise.run` and common
 * language CDNs so `mise install <tool>` works post-lockdown.
 */
export const misePluginSchema = z.object({
  type: z.literal('mise'),
});

export type MisePlugin = z.infer<typeof misePluginSchema>;
