import { loadSandboxConfig } from '#src/config/index.js';
import { assertPlatformSupported } from '#src/vm/platform.js';

import { destroyIfExists, runCreate } from './create.js';

/**
 * Destroy an existing sandbox VM (if any) and create a fresh one in its
 * place. Use after editing `.aurica/sandbox.json`, or to recover from a
 * failed init — the init pipeline isn't idempotent (iptables lockdown,
 * `git clone ~/project`, plugin bootstrap snippets all assume a fresh
 * VM), so destroy-and-recreate is the safe retry path.
 *
 * Defaults the VM name to the `name` field in `.aurica/sandbox.json` to
 * match `create`.
 */
export async function runRebuild(
  projectDir: string,
  nameArg: string | undefined,
): Promise<void> {
  assertPlatformSupported();
  let name = nameArg;
  if (!name) {
    const config = await loadSandboxConfig(projectDir);
    name = config.name;
  }
  await destroyIfExists(name);
  await runCreate(projectDir, name);
}
