import fs from 'node:fs/promises';

import { z } from 'zod';

import { userPluginsSchema } from '#src/plugins/index.js';

import { userConfigPath } from './paths.js';

/**
 * Strict user-level config schema. `plugins` is a keyed object of
 * per-plugin user defaults, validated against each plugin's own
 * `userConfigSchema`. Plugins without a user schema may not appear here.
 */
const userConfigSchema = z.object({
  vm: z.object({
    provider: z.literal('orb'),
    distro: z.enum(['ubuntu', 'debian']).default('ubuntu'),
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
  plugins: userPluginsSchema.default({}),
});

export type UserConfig = z.infer<typeof userConfigSchema>;

const defaultUserConfig: UserConfig = {
  vm: { provider: 'orb', distro: 'ubuntu' },
  credentialProviders: [{ provider: 'env' }],
  credentialCache: { idleTimeoutSeconds: 900 },
  plugins: {},
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
