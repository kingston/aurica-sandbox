import ora from 'ora';

import { logger } from '#src/logger.js';
import { readState, signalProxyReload, withState } from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';
import { waitForIp } from '#src/vm/wait-for-ip.js';

import { resolveTarget } from './find-primary.js';
import { ensureProxyRunning } from './proxy.js';

/**
 * Resume a previously stopped sandbox VM. Requires the proxy to be
 * running, the sandbox to be registered in state, and its current
 * status to be `'stopped'` — refuses to resume a `'failed-init'` VM
 * since its init pipeline never completed (the user should re-run
 * `create --force` to destroy and recreate).
 *
 * When `nameArg` is omitted, targets the project's primary sandbox.
 *
 * Calls `orbctl start`, polls for an IPv4, then updates state to
 * `'running'` with the fresh IP and signals the proxy to reload its
 * allowlist.
 */
export async function runStart(
  projectDir: string,
  nameArg?: string,
): Promise<void> {
  await ensureProxyRunning();

  const state = await readState();
  const entry = resolveTarget(state, projectDir, nameArg);
  const name = entry.name;
  if (entry.status === 'running') {
    logger.info(`${name} is already running`);
    return;
  }
  if (entry.status === 'failed-init') {
    throw new Error(
      `Sandbox ${name} has status 'failed-init' and cannot be resumed. Run \`aurica-sandbox create ${name} --force\` to destroy and recreate it.`,
    );
  }
  if (entry.status !== 'stopped') {
    throw new Error(
      `Sandbox ${name} has status '${entry.status}' and cannot be started.`,
    );
  }

  await withState((s) => {
    const e = s.sandboxes[name];
    if (e) e.status = 'starting';
  });

  const startSpinner = ora(`starting VM ${name}`).start();
  try {
    await defaultProvider.startVM(name);
    startSpinner.succeed(`started VM ${name}`);
  } catch (err) {
    startSpinner.fail(`start failed for ${name}`);
    throw err;
  }

  const ipSpinner = ora('waiting for IP').start();
  const vm = await waitForIp(name);
  const ip = vm.networkInfo?.ipV4 ?? null;
  if (ip) {
    ipSpinner.succeed(`got IP ${ip}`);
  } else {
    ipSpinner.fail('no IP after 30s');
    throw new Error(
      `VM ${name} did not acquire an IPv4 within 30 seconds after start`,
    );
  }

  await withState((s) => {
    const e = s.sandboxes[name];
    if (e) {
      e.status = 'running';
      e.ip = ip;
    }
  });
  await signalProxyReload();
  logger.info(`started ${name}`);
}
