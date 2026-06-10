import ora from 'ora';

import { readState, signalProxyReload, withState } from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';
import { assertPlatformSupported } from '#src/vm/platform.js';

import { resolveTarget } from './find-primary.js';

async function destroyOne(name: string, force: boolean): Promise<void> {
  const { result: registered } = await withState((state) => {
    const exists = name in state.sandboxes;
    if (exists) {
      const next = { ...state.sandboxes };
      Reflect.deleteProperty(next, name);
      state.sandboxes = next;
    }
    return exists;
  });

  if (!registered && !force) {
    throw new Error(
      `Sandbox ${name} not found in state. Use --force to remove the VM anyway.`,
    );
  }

  const spinner = ora(`destroying VM ${name}`).start();
  try {
    await defaultProvider.destroyVM(name);
    spinner.succeed(`destroyed VM ${name}`);
  } catch (err) {
    if (force) {
      spinner.warn(`destroy failed for ${name} (--force, continuing)`);
    } else {
      spinner.fail(`destroy failed for ${name}`);
      throw err;
    }
  }
}

/**
 * Unregister a sandbox from state and destroy the underlying VM.
 *
 * When `nameArg` is omitted, targets the project's primary sandbox. If
 * the target is a primary with live forks, the destroy is refused unless
 * `cascade` is true, in which case all forks are destroyed first.
 *
 * With `force` true, missing state entries and VM-destroy failures are
 * tolerated — useful when state and the VM provider have drifted out of
 * sync. In that mode an explicit `nameArg` is destroyed directly even if
 * it isn't registered.
 */
export async function runDestroy(
  projectDir: string,
  nameArg: string | undefined,
  force: boolean,
  cascade = false,
): Promise<void> {
  assertPlatformSupported();
  // Resolve the target. With an explicit name, keep using it verbatim so
  // `--force` can still destroy a VM that isn't registered in state.
  // Without a name, default to the project's primary.
  let name = nameArg;
  if (!name) {
    const state = await readState();
    name = resolveTarget(state, projectDir).name;
  }

  // Check for live forks before touching anything.
  const { result: forkNames } = await withState((state) => {
    const entry = state.sandboxes[name];
    if (entry?.kind !== 'primary') return [];
    return Object.values(state.sandboxes)
      .filter((e) => e.kind === 'fork' && e.parentName === name)
      .map((e) => e.name);
  });

  if (forkNames.length > 0 && !cascade) {
    throw new Error(
      `Cannot destroy primary ${name}: ${forkNames.length} fork(s) still exist: ${forkNames.join(', ')}.\n` +
        `Destroy them first or use --cascade to remove them automatically.`,
    );
  }

  // Cascade: destroy each fork one at a time, then the primary. Sequential
  // so the per-VM `ora` spinners don't overwrite each other and a mid-cascade
  // failure leaves the remaining VMs (and the primary) untouched.
  for (const forkName of forkNames) {
    await destroyOne(forkName, force);
  }

  await destroyOne(name, force);
  await signalProxyReload();
}
