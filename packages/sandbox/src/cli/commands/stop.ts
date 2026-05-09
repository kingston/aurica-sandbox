import ora from 'ora';

import { logger } from '#src/logger.js';
import { readState, signalProxyReload, withState } from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';

/**
 * Pause a running sandbox VM. Calls `orbctl stop` so the underlying
 * machine actually halts (preserving its disk for a later `start`),
 * then flips the state entry to `'stopped'` and clears its IP since
 * OrbStack releases the address when a VM is stopped. The proxy is
 * signalled to reload so its allowlist no longer matches the now-gone
 * IP.
 *
 * Throws if no sandbox with this name is registered. No-ops with an
 * info log if the sandbox is already stopped.
 */
export async function runStop(name: string): Promise<void> {
  const state = await readState();
  const entry = state.sandboxes[name];
  if (!entry) throw new Error(`Sandbox ${name} not found`);
  if (entry.status === 'stopped') {
    logger.info(`${name} is already stopped`);
    return;
  }

  await withState((s) => {
    const e = s.sandboxes[name];
    if (e) e.status = 'stopping';
  });

  const spinner = ora(`stopping VM ${name}`).start();
  try {
    await defaultProvider.stopVM(name);
    spinner.succeed(`stopped VM ${name}`);
  } catch (err) {
    spinner.fail(`stop failed for ${name}`);
    throw err;
  }

  await withState((s) => {
    const e = s.sandboxes[name];
    if (e) {
      e.status = 'stopped';
      e.ip = null;
    }
  });
  await signalProxyReload();
  logger.info(`stopped ${name}`);
}
