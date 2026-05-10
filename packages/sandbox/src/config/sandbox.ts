import fs from 'node:fs/promises';

import { z } from 'zod';

import {
  GH_TOKEN_API_INCOMPATIBLE_MESSAGE,
  githubPluginShape,
  githubTokenSourceSchema,
} from '#src/plugins/github/schema.js';
import {
  claudeCodePluginSchema,
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
 * user-level (`username`, `tokenSource`, `user`) marked optional.
 * `repositories`, `name`, and other repo-shape fields stay required so
 * config errors at the project layer surface clearly. After merging with
 * user-level defaults, the result is re-parsed against the strict schema.
 */
// Rebuild from {@link githubPluginShape} rather than `.extend()`-ing the
// strict schema: Zod 4 errors out when `.extend()` is called on a refined
// schema, and the strict schema carries a `.check()`. We re-apply the
// same invariant here by hand. The check is gated on
// `tokenSource !== undefined`, so user-layer-sourced fields don't
// false-positive at the loose-parse stage; the strict re-parse after
// merging catches the merged-bad case.
const looseProjectGithubPluginSchema = z
  .object({
    ...githubPluginShape,
    username: z.string().min(1).optional(),
    tokenSource: githubTokenSourceSchema.optional(),
  })
  .check((ctx) => {
    if (ctx.value.tokenSource === 'gh-token' && ctx.value.api === true) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: GH_TOKEN_API_INCOMPATIBLE_MESSAGE,
      });
    }
  });

const looseProjectPluginSchema = z.discriminatedUnion('type', [
  looseProjectGithubPluginSchema,
  dockerPluginSchema,
  misePluginSchema,
  claudeCodePluginSchema,
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
        claudeCodePluginSchema,
      ]),
    )
    .default([]),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/**
 * Load and validate `.aurica/sandbox.json` for `projectDir`, layered with
 * user-level defaults from `~/.aurica/sandbox/config.json`.
 *
 * The project file is allowed to omit `username`/`tokenSource`/`user` on
 * github plugins — those can come from the user layer via `mergePlugins`. After
 * merging, the result must satisfy the strict schema; otherwise the parse
 * error names the merged-but-still-incomplete plugin so users can see
 * which field neither layer provided.
 *
 * Throws if the project file is missing, either layer fails its schema, or
 * the merged config fails strict validation. Per-plugin cross-field
 * invariants live on the plugin schemas themselves (e.g. github's
 * `gh-token` + `api: true` incompatibility) and surface as part of the
 * strict re-parse.
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
  return sandboxConfigSchema.parse(merged);
}

export function defaultSandboxConfig(name: string): SandboxConfig {
  return {
    name,
    resources: { cpu: 4, memoryMb: 8192, diskGb: 50 },
    proxy: { domains: [], policies: [] },
    plugins: [],
  };
}
