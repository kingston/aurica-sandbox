import ora from 'ora';

import { signalProxyReload, withState } from '#src/state/index.js';
import { orbProvider } from '#src/vm/index.js';

/**
 * Unregister `name` from state and destroy the underlying VM. With `force`
 * true, missing state entries and VM-destroy failures are tolerated — useful
 * when state and the VM provider have drifted out of sync.
 */
export async function runDestroy(name: string, force: boolean): Promise<void> {
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
    await orbProvider.destroyVM(name);
    spinner.succeed(`destroyed VM ${name}`);
  } catch (err) {
    if (force) {
      spinner.warn(`destroy failed for ${name} (--force, continuing)`);
    } else {
      spinner.fail(`destroy failed for ${name}`);
      throw err;
    }
  }

  await signalProxyReload();
}
