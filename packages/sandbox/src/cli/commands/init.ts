import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultSandboxConfig, sandboxConfigPath } from '#src/config/index.js';
import { logger } from '#src/logger.js';
import { readHostGitIdentity } from '#src/plugins/github/host-identity.js';
import type { GithubPlugin } from '#src/plugins/index.js';

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

  // Pre-fill the github plugin's `user` field from the host's `~/.gitconfig`
  // when both name and email are set. Once written into the sample, the
  // values are part of the committed config and reproducible across
  // machines — re-running init on a different machine won't overwrite them.
  const hostIdentity = await readHostGitIdentity();
  const githubPlugin: GithubPlugin = {
    type: 'github',
    username: 'x-access-token',
    ...(hostIdentity ? { user: hostIdentity } : {}),
    repositories: [{ name: 'owner/repo' }],
    token: 'env:GITHUB_API_KEY',
  };

  const sample = {
    ...defaultSandboxConfig(path.basename(projectDir)),
    plugins: [githubPlugin],
  };
  await fs.writeFile(configPath, `${JSON.stringify(sample, null, 2)}\n`);
  logger.info(`Wrote ${configPath}`);
  if (!hostIdentity) {
    logger.warn(
      'host git user.name / user.email not set; sandbox commits will use the VM default. Edit `.aurica/sandbox.json` to add `user: { name, email }` to the github plugin, or run `git config --global user.name "..."` and `user.email "..."` on the host before re-running init.',
    );
  }
}
