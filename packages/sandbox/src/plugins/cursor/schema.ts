import { z } from 'zod';

/**
 * Cursor plugin project config. No project-level options today — activating
 * the plugin (`{ "cursor": {} }`) is enough.
 */
export const cursorProjectConfigSchema = z.object({});

/** Cursor plugin project config — see {@link cursorProjectConfigSchema}. */
export type CursorProjectConfig = z.infer<typeof cursorProjectConfigSchema>;
