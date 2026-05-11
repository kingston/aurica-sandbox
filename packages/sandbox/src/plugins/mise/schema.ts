import { z } from 'zod';

/**
 * mise plugin project config. The plugin currently exposes no project-level
 * options — `{ "mise": {} }` is enough to activate it.
 */
export const miseProjectConfigSchema = z.object({});

/** mise plugin project config — see {@link miseProjectConfigSchema}. */
export type MiseProjectConfig = z.infer<typeof miseProjectConfigSchema>;
