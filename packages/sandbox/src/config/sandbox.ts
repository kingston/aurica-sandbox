import fs from 'node:fs/promises';

import { z } from 'zod';

import { parseCredentialSource } from '#src/credentials/index.js';
import {
  dockerPluginSchema,
  githubPluginSchema,
  misePluginSchema,
} from '#src/plugins/schema.js';

import { mergePlugins } from './merge.js';
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
 * Project-side plugin schema with the fields users typically push to
 * user-level (`username`, `token`, `user`) marked optional. `repositories`,
 * `name`, and other repo-shape fields stay required so config errors at
 * the project layer surface clearly. After merging with user-level
 * defaults, the result is re-parsed against the strict schema.
 */
const looseProjectGithubPluginSchema = githubPluginSchema.extend({
  username: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
});

const looseProjectPluginSchema = z.discriminatedUnion('type', [
  looseProjectGithubPluginSchema,
  dockerPluginSchema,
  misePluginSchema,
]);

const looseProjectSandboxSchema = z.object({
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
  plugins: z.array(looseProjectPluginSchema).default([]),
});

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
  plugins: z
    .array(
      z.discriminatedUnion('type', [
        githubPluginSchema,
        dockerPluginSchema,
        misePluginSchema,
      ]),
    )
    .default([]),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/**
 * Cross-field invariants that don't fit naturally into the schema:
 * - Each credentialed plugin's `token` must be a parseable credential source.
 */
function assertConfigInvariants(config: SandboxConfig): void {
  for (const plugin of config.plugins) {
    if (plugin.type === 'github') {
      parseCredentialSource(plugin.token);
    }
  }
}

/**
 * Load and validate `.aurica/sandbox.json` for `projectDir`, layered with
 * user-level defaults from `~/.aurica/sandbox/config.json`.
 *
 * The project file is allowed to omit `username`/`token`/`user` on github
 * plugins — those can come from the user layer via `mergePlugins`. After
 * merging, the result must satisfy the strict schema; otherwise the parse
 * error names the merged-but-still-incomplete plugin so users can see
 * which field neither layer provided.
 *
 * Throws if the project file is missing, either layer fails its schema,
 * the merged config fails strict validation, or any cross-field invariant
 * fails (e.g. plugin token isn't a parseable credential source).
 */
export async function loadSandboxConfig(
  projectDir: string,
): Promise<SandboxConfig> {
  const userConfig = await loadUserConfig();
  const configPath = sandboxConfigPath(projectDir);
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const projectParsed = looseProjectSandboxSchema.parse(parsed);
  const merged = {
    ...projectParsed,
    plugins: mergePlugins(userConfig.plugins, projectParsed.plugins),
  };
  const config = sandboxConfigSchema.parse(merged);
  assertConfigInvariants(config);
  return config;
}

export function defaultSandboxConfig(name: string): SandboxConfig {
  return {
    name,
    resources: { cpu: 4, memoryMb: 8192, diskGb: 50 },
    proxy: { domains: [], policies: [] },
    plugins: [],
  };
}
