import fs from 'node:fs/promises';
import path from 'node:path';

import {
  defaultSandboxConfig,
  sandboxConfigPath,
  userConfigPath,
} from '#src/config/index.js';
import { logger } from '#src/logger.js';

export async function runInit(projectDir: string): Promise<void> {
  const configPath = sandboxConfigPath(projectDir);
  let exists = false;
  try {
    await fs.access(configPath);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (exists) {
    throw new Error(`Refusing to overwrite existing config at ${configPath}`);
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const sample = {
    ...defaultSandboxConfig(path.basename(projectDir)),
    plugins: [
      {
        type: 'github' as const,
        repositories: [{ name: 'owner/repo' }],
      },
    ],
  };
  await fs.writeFile(configPath, `${JSON.stringify(sample, null, 2)}\n`);
  logger.info(`Wrote ${configPath}`);
  logger.info(
    `Set github plugin defaults (username, token, user) at ${userConfigPath()} — see docs for the schema.`,
  );
}
