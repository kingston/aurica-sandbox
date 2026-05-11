import { z } from 'zod';

/**
 * mise plugin. Installs mise from the official `mise.en.dev/deb` apt repo
 * pre-lockdown (binary lands at `/usr/bin/mise`, so it's on PATH for every
 * shell) and wires up the bash/zsh/fish activation shim. Contributes proxy
 * domains for the apt repo and common language CDNs so `mise install <tool>`
 * works post-lockdown.
 */
export const misePluginSchema = z.object({
  type: z.literal('mise'),
});

export type MisePlugin = z.infer<typeof misePluginSchema>;
