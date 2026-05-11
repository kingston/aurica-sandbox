import fs from 'node:fs/promises';

import { z } from 'zod';

import {
  projectPluginsSchema,
  type ProjectPlugins,
  type UserPlugins,
} from '#src/plugins/index.js';

import { sandboxConfigPath } from './paths.js';
import { proxyPolicySchema } from './proxy-policy.js';
import { loadUserConfig } from './user.js';

export {
  httpMethodSchema,
  matcherEntrySchema,
  mutationSchema,
  policyActionSchema,
  proxyPolicySchema,
  proxyPolicyTransformSchema,
} from './proxy-policy.js';
export type {
  HttpMethod,
  MatcherEntry,
  Mutation,
  PolicyAction,
  ProxyPolicy,
  ProxyPolicyTransform,
} from './proxy-policy.js';

/**
 * Project-side sandbox config schema. `plugins` is a keyed object where
 * each key is a plugin name and the value is that plugin's
 * project-level config — opt-in by inclusion. Strict: every block is
 * validated against the plugin's `projectConfigSchema`.
 */
export const sandboxConfigSchema = z.object({
  name: z.string().min(1),
  resources: z
    .object({
      cpu: z.number().int().positive().default(4),
      memoryMb: z.number().int().positive().default(8192),
      diskGb: z.number().int().positive().default(50),
    })
    .default({ cpu: 4, memoryMb: 8192, diskGb: 50 }),
  proxy: z
    .object({
      domains: z.array(z.string().min(1)).default([]),
      policies: z.array(proxyPolicySchema).default([]),
    })
    .default({ domains: [], policies: [] }),
  plugins: projectPluginsSchema.default({}),
});

/**
 * Parsed sandbox config. `userPlugins` is attached from
 * `~/.aurica/sandbox/config.json` at load time so downstream consumers
 * (proxy reload, sandbox create) can pass both halves to `expandPlugins`
 * without re-reading the user file.
 */
export type SandboxConfig = z.infer<typeof sandboxConfigSchema> & {
  userPlugins: UserPlugins;
};

/**
 * Load and validate `.aurica/sandbox.json` for `projectDir` and merge in
 * user-level plugin defaults from `~/.aurica/sandbox/config.json`.
 *
 * Both files are validated independently against their respective strict
 * schemas — no looseness, no field-level merge. Plugins resolve their own
 * fallbacks at `initialize` time, where domain-specific defaulting rules
 * live.
 *
 * Throws if the project file is missing, either layer fails its schema,
 * or a plugin's own `.check()` invariant fires (e.g. github's `gh-token`
 * + `api: true` incompatibility).
 */
export async function loadSandboxConfig(
  projectDir: string,
): Promise<SandboxConfig> {
  const userConfig = await loadUserConfig();
  const configPath = sandboxConfigPath(projectDir);
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const project = sandboxConfigSchema.parse(parsed);
  return { ...project, userPlugins: userConfig.plugins };
}

export function defaultSandboxConfig(
  name: string,
): Omit<SandboxConfig, 'userPlugins'> {
  return {
    name,
    resources: { cpu: 4, memoryMb: 8192, diskGb: 50 },
    proxy: { domains: [], policies: [] },
    plugins: {} as ProjectPlugins,
  };
}
