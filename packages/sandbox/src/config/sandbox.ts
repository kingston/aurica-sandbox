import fs from 'node:fs/promises';

import { z } from 'zod';

import { parseCredentialSource } from '#src/credentials/index.js';
import { pluginSchema } from '#src/plugins/schema.js';

import { sandboxConfigPath } from './paths.js';
import { proxyPolicySchema } from './proxy-policy.js';

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
  plugins: z.array(pluginSchema).default([]),
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
 * Load and validate `.aurica/sandbox.json` for `projectDir`. Throws if the
 * file is missing, fails schema validation, or fails any cross-field
 * invariant (e.g. plugin token isn't a parseable credential source).
 */
export async function loadSandboxConfig(
  projectDir: string,
): Promise<SandboxConfig> {
  const configPath = sandboxConfigPath(projectDir);
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const config = sandboxConfigSchema.parse(parsed);
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
