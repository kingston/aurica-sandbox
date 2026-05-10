import { z } from 'zod';

import { claudeCodePluginSchema } from './claude-code/schema.js';
import { dockerPluginSchema } from './docker/schema.js';
import { githubPluginSchema } from './github/schema.js';
import { misePluginSchema } from './mise/schema.js';

export { githubPluginSchema } from './github/schema.js';
export type { GithubPlugin } from './github/schema.js';
export { dockerPluginSchema } from './docker/schema.js';
export type { DockerPlugin } from './docker/schema.js';
export { misePluginSchema } from './mise/schema.js';
export type { MisePlugin } from './mise/schema.js';
export { claudeCodePluginSchema } from './claude-code/schema.js';
export type { ClaudeCodePlugin } from './claude-code/schema.js';

/** Discriminated union over all plugin providers. */
export const pluginSchema = z.discriminatedUnion('type', [
  githubPluginSchema,
  dockerPluginSchema,
  misePluginSchema,
  claudeCodePluginSchema,
]);

export type Plugin = z.infer<typeof pluginSchema>;
