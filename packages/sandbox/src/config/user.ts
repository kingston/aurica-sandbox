import fs from 'node:fs/promises';

import { z } from 'zod';

import { userConfigPath } from './paths.js';

/**
 * Loose user-level plugin entry. Only the discriminator `type` is
 * validated here — every other field is passed through untouched. The
 * merged result is validated against the strict plugin schema by
 * `loadSandboxConfig`, so any missing or malformed field surfaces with the
 * full strict error there. Validating twice would duplicate rules and
 * force us to keep two schemas in sync.
 */
const userPluginSchema = z.looseObject({
  type: z.string(),
});

/** A plugin entry as it appears in user-level config. */
export type UserPlugin = z.infer<typeof userPluginSchema>;

const userConfigSchema = z.object({
  vm: z.object({
    provider: z.literal('orb'),
    distro: z.enum(['ubuntu', 'debian', 'nixos']).default('ubuntu'),
  }),
  credentialProviders: z
    .array(
      z.object({
        provider: z.literal('env'),
      }),
    )
    .default([{ provider: 'env' }]),
  credentialCache: z
    .object({
      idleTimeoutSeconds: z.number().int().positive().default(900),
    })
    .default({ idleTimeoutSeconds: 900 }),
  plugins: z.array(userPluginSchema).default([]),
});

export type UserConfig = z.infer<typeof userConfigSchema>;

const defaultUserConfig: UserConfig = {
  vm: { provider: 'orb', distro: 'ubuntu' },
  credentialProviders: [{ provider: 'env' }],
  credentialCache: { idleTimeoutSeconds: 900 },
  plugins: [],
};

/**
 * Load the user-level config from `userConfigPath()`. Returns built-in
 * defaults if the file does not exist; throws on parse / schema errors.
 */
export async function loadUserConfig(): Promise<UserConfig> {
  const configPath = userConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultUserConfig;
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return userConfigSchema.parse(parsed);
}
