import { z } from 'zod';

import { dockerPluginSchema } from './docker/schema.js';
import { githubPluginSchema } from './github/schema.js';
import { misePluginSchema } from './mise/schema.js';

export {
  githubPermissionLevelSchema,
  githubPermissionsSchema,
  githubPluginSchema,
} from './github/schema.js';
export type {
  GithubPermissionLevel,
  GithubPermissions,
  GithubPlugin,
} from './github/schema.js';
export { dockerPluginSchema } from './docker/schema.js';
export type { DockerPlugin } from './docker/schema.js';
export { misePluginSchema } from './mise/schema.js';
export type { MisePlugin } from './mise/schema.js';

/** Discriminated union over all plugin providers. */
export const pluginSchema = z.discriminatedUnion('type', [
  githubPluginSchema,
  dockerPluginSchema,
  misePluginSchema,
]);

export type Plugin = z.infer<typeof pluginSchema>;
