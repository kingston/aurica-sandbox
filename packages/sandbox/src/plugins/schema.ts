import { z } from 'zod';

import { PLUGINS, type PluginRegistry } from './registry.js';

export type { GithubProjectConfig, GithubUserConfig } from './github/schema.js';
export type { DockerProjectConfig } from './docker/schema.js';
export type { MiseProjectConfig } from './mise/schema.js';
export type { ClaudeCodeProjectConfig } from './claude-code/schema.js';
export type { CursorProjectConfig } from './cursor/schema.js';

/**
 * Keyed project-plugins shape derived from the registry tuple. Each plugin
 * appears under its `name` key as an *optional* schema — a sandbox project
 * opts into a plugin by including the key, omits it to disable.
 */
type ProjectPluginsShape = {
  [P in PluginRegistry[number] as P['name']]: z.ZodOptional<
    P['projectConfigSchema']
  >;
};

/** Subset of the registry whose plugins declare a `userConfigSchema`. */
type PluginsWithUserConfig = Extract<
  PluginRegistry[number],
  { userConfigSchema: z.ZodType }
>;

/**
 * Keyed user-plugins shape derived from the registry tuple. Only plugins
 * that declare a `userConfigSchema` appear here. Every entry is optional —
 * a user config may set defaults for any subset of plugins.
 */
type UserPluginsShape = {
  [P in PluginsWithUserConfig as P['name']]: z.ZodOptional<
    NonNullable<P['userConfigSchema']>
  >;
};

/**
 * Build the keyed project-config zod schema by iterating the registry and
 * marking each plugin's `projectConfigSchema` optional. Cast to the precise
 * `ProjectPluginsShape` because `Object.fromEntries` widens to
 * `Record<string, ZodType>`.
 */
function buildProjectPluginsSchema(): z.ZodObject<ProjectPluginsShape> {
  const entries = PLUGINS.map(
    (p) => [p.name, p.projectConfigSchema.optional()] as const,
  );
  return z.object(
    Object.fromEntries(entries) as unknown as ProjectPluginsShape,
  );
}

/**
 * Build the keyed user-config zod schema. Skips plugins whose
 * `userConfigSchema` is undefined.
 */
function buildUserPluginsSchema(): z.ZodObject<UserPluginsShape> {
  const entries: (readonly [string, z.ZodOptional<z.ZodType>])[] = [];
  for (const p of PLUGINS) {
    if (p.userConfigSchema) {
      entries.push([p.name, p.userConfigSchema.optional()] as const);
    }
  }
  return z.object(Object.fromEntries(entries) as unknown as UserPluginsShape);
}

/** Strict project-side keyed `plugins` schema. */
export const projectPluginsSchema = buildProjectPluginsSchema();

/** Strict user-side keyed `plugins` schema. */
export const userPluginsSchema = buildUserPluginsSchema();

/** Parsed project-side `plugins` block. */
export type ProjectPlugins = z.infer<typeof projectPluginsSchema>;

/** Parsed user-side `plugins` block. */
export type UserPlugins = z.infer<typeof userPluginsSchema>;
