import fs from 'node:fs/promises';

import { z } from 'zod';

import { parseCredentialSource } from '#src/credentials/index.js';
import { pluginDomainsForGitCoverage } from '#src/plugins/index.js';
import { pluginSchema } from '#src/plugins/schema.js';
import { matchDomain } from '#src/proxy/substitution.js';

import { sandboxConfigPath } from './paths.js';
import { proxyActionSchema } from './proxy-action.js';

export { proxyActionSchema } from './proxy-action.js';
export type { ProxyAction } from './proxy-action.js';

/**
 * Per-project git clone settings. When present, `aurica-sandbox start` will
 * clone `url` (optionally at `ref`) into `/home/<user>/project` inside the VM
 * after the built-in bootstrap and before the user/project init scripts.
 *
 * `tokenSource` is a credential-source string parseable by
 * {@link parseCredentialSource} (currently only `env:VAR` is supported). The
 * real token never enters the VM — the orchestrator configures git with a
 * placeholder Bearer header, and the host proxy substitutes the real token
 * at request time.
 */
export const gitConfigSchema = z.object({
  url: z.url(),
  ref: z.string().min(1).optional(),
  tokenSource: z.string().min(1).optional(),
});

export type GitConfig = z.infer<typeof gitConfigSchema>;

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
      actions: z.array(proxyActionSchema).default([]),
    })
    .default({ domains: [], actions: [] }),
  plugins: z.array(pluginSchema).default([]),
  git: gitConfigSchema.optional(),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/**
 * Cross-field invariants that don't fit naturally into the schema:
 * - Each credentialed plugin's `token` must be a parseable credential source.
 * - `git.tokenSource` (if set) must parse.
 * - `git.url`'s host must be covered by either `proxy.domains` or the domain
 *   set contributed by a plugin; otherwise the clone will fail at run time
 *   with an opaque proxy 403.
 */
function assertConfigInvariants(config: SandboxConfig): void {
  for (const plugin of config.plugins) {
    if (plugin.type === 'github') {
      parseCredentialSource(plugin.token);
    }
  }
  if (!config.git) return;
  if (config.git.tokenSource) {
    parseCredentialSource(config.git.tokenSource);
  }
  const host = new URL(config.git.url).host;
  const pluginDomains = config.plugins.flatMap((p) =>
    pluginDomainsForGitCoverage(p),
  );
  const covered = [...config.proxy.domains, ...pluginDomains].some((pattern) =>
    matchDomain(pattern, host),
  );
  if (!covered) {
    throw new Error(
      `git.url host '${host}' is not covered by proxy.domains or any plugin; ` +
        `add '${host}' (or a matching glob like '*.${host.replace(/^[^.]+\./, '')}') ` +
        `to .aurica/sandbox.json proxy.domains, or add a plugin that covers it`,
    );
  }
}

/**
 * Load and validate `.aurica/sandbox.json` for `projectDir`. Throws if the
 * file is missing, fails schema validation, or fails any cross-field
 * invariant (e.g. git.url host not in proxy.domains).
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
    proxy: { domains: [], actions: [] },
    plugins: [],
  };
}
