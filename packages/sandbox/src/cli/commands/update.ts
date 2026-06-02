import os from 'node:os';
import path from 'node:path';

import ora from 'ora';

import { loadSandboxConfig } from '#src/config/index.js';
import { logger } from '#src/logger.js';
import { deriveFromConfig } from '#src/proxy/derive-rules.js';
import { readState, signalProxyReload, withState } from '#src/state/index.js';
import { statDirOrNull } from '#src/utils/path-exists.js';
import { defaultProvider } from '#src/vm/index.js';
import { runUpdateHooks } from '#src/vm/init/run-update.js';
import { waitForIp } from '#src/vm/wait-for-ip.js';

import { resolveTarget } from './find-primary.js';
import { ensureProxyRunning } from './proxy.js';

/**
 * Run `update.sh` hooks against an existing sandbox VM — a lightweight
 * refresh (typically `git pull` + `pnpm install`) without rebuilding from
 * scratch.
 *
 * When `nameArg` is omitted, targets the project's primary. The target may
 * be a primary or a fork; primaries do not cascade to their forks (each
 * fork must be updated explicitly).
 *
 * If the VM is stopped, it is started first and left running afterwards.
 * Sandboxes in `creating` or `failed-init` state are rejected with a
 * pointer to `rebuild`.
 *
 * If no `update.sh` exists at either `~/.aurica/sandbox/init/` or
 * `<projectDir>/.aurica/init/`, this is a clean no-op.
 *
 * Hook failures surface as thrown errors; the VM is left running and the
 * state entry is not flipped to `failed-init` — the sandbox itself is
 * still usable, only the refresh failed.
 */
export async function runUpdate(
  projectDir: string,
  nameArg?: string,
): Promise<void> {
  await ensureProxyRunning();

  const state = await readState();
  const entry = resolveTarget(state, projectDir, nameArg);

  const name = entry.name;
  const wasStopped = entry.status === 'stopped';

  if (entry.status === 'creating' || entry.status === 'failed-init') {
    throw new Error(
      `Sandbox ${name} has status '${entry.status}' and cannot be updated. Run \`aurica-sandbox rebuild ${name}\` to destroy and recreate it.`,
    );
  }

  if (wasStopped) {
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
  } else if (entry.status !== 'running') {
    throw new Error(
      `Sandbox ${name} has status '${entry.status}' and cannot be updated.`,
    );
  }

  // Resolve project cwd override the same way `runCreate` does so the
  // github plugin's checkout path is honored — `update.sh` lands inside
  // the repo without needing `cd $AURICA_PROJECT_DIR`.
  const config = await loadSandboxConfig(projectDir);
  const linuxUser = process.env.USER ?? 'sandbox';
  const expanded = await deriveFromConfig(config, {
    user: linuxUser,
    sandboxName: name,
    authSecret: entry.authSecret,
  });

  const userInitDir = await statDirOrNull(
    path.join(os.homedir(), '.aurica', 'sandbox', 'init'),
  );
  const projectInitDir = await statDirOrNull(
    path.join(projectDir, '.aurica', 'init'),
  );

  const primaryName =
    entry.kind === 'fork' && entry.parentName ? entry.parentName : name;

  const exec = defaultProvider.createExec(name, linuxUser);
  let hookError: Error | undefined;
  let ranAny = false;
  try {
    ranAny = await runUpdateHooks(exec, {
      user: linuxUser,
      sandboxName: name,
      sandboxKind: entry.kind,
      primaryName,
      userInitDir,
      projectInitDir,
      ...(expanded.projectInitCwdOverride !== undefined
        ? { projectInitCwdOverride: expanded.projectInitCwdOverride }
        : {}),
    });
  } catch (err) {
    hookError = err instanceof Error ? err : new Error(String(err));
  }

  // Restore the VM's prior status. If we started it just for this update,
  // stop it again so `update` doesn't silently change a previously-paused
  // sandbox into a running one. Runs even when the hook threw — we don't
  // want a failed update to leak a started VM. A stop failure is logged
  // but doesn't mask the more useful original hook error.
  if (wasStopped) {
    const stopSpinner = ora(`stopping VM ${name}`).start();
    try {
      await defaultProvider.stopVM(name);
      stopSpinner.succeed(`stopped VM ${name}`);
      await withState((s) => {
        const e = s.sandboxes[name];
        if (e) {
          e.status = 'stopped';
          e.ip = null;
        }
      });
      await signalProxyReload();
    } catch (stopErr) {
      stopSpinner.fail(`stop failed for ${name}`);
      if (hookError === undefined) throw stopErr;
      logger.warn(
        `stop after failed update also failed: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
      );
    }
  }

  if (hookError !== undefined) throw hookError;

  if (!ranAny) {
    logger.info(
      `No update hooks found (looked for update.sh in ~/.aurica/sandbox/init/ and ${projectDir}/.aurica/init/).`,
    );
    return;
  }

  const finalStatus = wasStopped ? 'stopped' : 'running';
  logger.log(
    JSON.stringify(
      { name, status: finalStatus, kind: entry.kind, projectDir },
      null,
      2,
    ),
  );
}
