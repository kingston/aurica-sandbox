import fs from 'node:fs/promises';

import { z } from 'zod';

import {
  projectPluginsSchema,
  type ProjectPlugins,
  type UserPlugins,
} from '#src/plugins/index.js';

import { parseConfigFile } from './parse-config-file.js';
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
  responseCacheSchema,
  responseInterceptorSchema,
} from './proxy-policy.js';
export type {
  HttpMethod,
  MatcherEntry,
  Mutation,
  PolicyAction,
  ProxyPolicy,
  ProxyPolicyTransform,
  ResponseCache,
  ResponseInterceptor,
} from './proxy-policy.js';

/**
 * Single host-to-VM file/directory copy declared in the project config.
 *
 * `src`: host path. A leading `~/` is expanded against the host user's
 * home directory; any other path is resolved against the project
 * directory containing `.aurica/sandbox.json`.
 *
 * `dest`: VM path. A leading `~/` is expanded against the default user's
 * home inside the VM (`/home/<user>/...`); any other path is resolved
 * against the project working directory inside the VM (the same value
 * `setup-project.sh` runs in — typically `/workspaces`, or the github
 * plugin's checkout root).
 */
export const fileCopyEntrySchema = z.object({
  src: z.string().min(1),
  dest: z.string().min(1),
});
export type FileCopyEntry = z.infer<typeof fileCopyEntrySchema>;

/**
 * Single host-to-VM bind-mount declared in the project config. Forwarded
 * to `orbctl create --mount` so changes inside the VM are visible on the
 * host (and vice versa) for the life of the machine.
 *
 * `src`: host path. Follows the same rules as `files[].src` — `~/`
 * expands against the host user's home, anything else resolves against
 * the project directory containing `.aurica/sandbox.json`. Must be an
 * existing directory; orbctl only bind-mounts directories.
 *
 * `dest`: optional absolute VM path. When omitted, orbctl mounts the
 * source at the same absolute path inside the VM (the `SOURCE`-only form
 * of `--mount`). When set, must start with `/`.
 *
 * Only honored at VM creation time. `orb clone` carries mounts to forks
 * automatically, so configuring them on the primary is enough.
 */
export const mountEntrySchema = z.object({
  src: z.string().min(1),
  dest: z.string().min(1).optional(),
});
export type MountEntry = z.infer<typeof mountEntrySchema>;

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
  files: z.array(fileCopyEntrySchema).default([]),
  mounts: z.array(mountEntrySchema).default([]),
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
  const project = parseConfigFile(configPath, raw, sandboxConfigSchema);
  return { ...project, userPlugins: userConfig.plugins };
}

export function defaultSandboxConfig(
  name: string,
): Omit<SandboxConfig, 'userPlugins'> {
  return {
    name,
    resources: { cpu: 4, memoryMb: 8192, diskGb: 50 },
    proxy: { domains: [], policies: [] },
    files: [],
    mounts: [],
    plugins: {} as ProjectPlugins,
  };
}
