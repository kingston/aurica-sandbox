import { z } from 'zod';

/**
 * Docker plugin project config. The plugin currently exposes no
 * project-level options — `{ "docker": {} }` is enough to activate it.
 */
export const dockerProjectConfigSchema = z.object({});

/** Docker plugin project config — see {@link dockerProjectConfigSchema}. */
export type DockerProjectConfig = z.infer<typeof dockerProjectConfigSchema>;
