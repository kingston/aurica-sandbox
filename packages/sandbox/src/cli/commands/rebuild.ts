import { defaultName, destroyIfExists, runCreate } from './create.js';

/**
 * Destroy an existing sandbox VM (if any) and create a fresh one in its
 * place. Use after editing `.aurica/sandbox.json`, or to recover from a
 * failed init — the init pipeline isn't idempotent (iptables lockdown,
 * `git clone ~/project`, plugin bootstrap snippets all assume a fresh
 * VM), so destroy-and-recreate is the safe retry path.
 *
 * Defaults the VM name to `<folder>-<branch>` to match `create`.
 */
export async function runRebuild(
  projectDir: string,
  nameArg: string | undefined,
): Promise<void> {
  const name = nameArg ?? (await defaultName(projectDir));
  await destroyIfExists(name);
  await runCreate(projectDir, name);
}
