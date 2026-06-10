import fs from 'node:fs/promises';
import path from 'node:path';

import {
  defaultSandboxConfig,
  sandboxConfigPath,
  userConfigPath,
} from '#src/config/index.js';
import { logger } from '#src/logger.js';
import { PLUGINS } from '#src/plugins/index.js';

/**
 * Scaffold `.aurica/sandbox.json` for `projectDir`.
 *
 * Writes a minimal but runnable config with the `github` plugin as a worked
 * example, then prints the other available plugins so they're discoverable
 * without reading source. Refuses to overwrite an existing config unless
 * `force` is set.
 */
export async function runInit(
  projectDir: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const configPath = sandboxConfigPath(projectDir);
  let exists = false;
  try {
    await fs.access(configPath);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (exists && !force) {
    throw new Error(
      `Refusing to overwrite existing config at ${configPath}. Pass --force to overwrite.`,
    );
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const sample = {
    ...defaultSandboxConfig(path.basename(projectDir)),
    proxy: { domains: ['*.github.com'], policies: [] },
    plugins: {
      github: {
        repositories: [{ name: 'owner/repo' }],
      },
    },
  };
  await fs.writeFile(configPath, `${JSON.stringify(sample, null, 2)}\n`);
  logger.success(`Wrote ${configPath}`);

  const otherPlugins = PLUGINS.map((p) => p.name)
    .filter((name) => name !== 'github')
    .join(', ');
  logger.info(
    `Edit it to add allowed proxy domains and enable plugins. Available plugins beyond github: ${otherPlugins}. See the Config section of the README for each plugin's schema.`,
  );
  logger.info(
    `User-level defaults (credential providers, per-plugin defaults) live at ${userConfigPath()}.`,
  );
}
