import ora from 'ora';

import { logger } from '#src/logger.js';
import { readState, signalProxyReload, withState } from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';

import { resolveTarget } from './find-primary.js';

/**
 * Pause a running sandbox VM via the active provider's `stopVM` so the
 * underlying machine actually halts (preserving its disk for a later
 * `start`), then flips the state entry to `'stopped'` and clears its IP
 * — providers typically release the address on stop, so the cached IP
 * would be stale on the next start. The proxy is signalled to reload so
 * its allowlist no longer matches the now-gone IP.
 *
 * When `nameArg` is omitted, targets the project's primary sandbox.
 * No-ops with an info log if the sandbox is already stopped.
 */
export async function runStop(
  projectDir: string,
  nameArg?: string,
): Promise<void> {
  const state = await readState();
  const entry = resolveTarget(state, projectDir, nameArg);
  const name = entry.name;
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
