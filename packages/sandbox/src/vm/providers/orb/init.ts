import { spawn } from 'node:child_process';

import { execa } from 'execa';

import type { VMExec } from '#src/vm/init/run-init.js';

const BOOT_POLL_TIMEOUT_MS = 30_000;
const BOOT_POLL_INTERVAL_MS = 500;
const SAFE_DEST = /^[A-Za-z0-9._/-]+$/;

/**
 * Build a {@link VMExec} backed by `orbctl` for an OrbStack machine.
 *
 * On the first call, the returned exec polls `orbctl run -m <name> echo ok`
 * until the VM is accepting commands (or {@link BOOT_POLL_TIMEOUT_MS}
 * elapses). This replaces the cloud-init `done` signal that the old
 * delivery path relied on — `orbctl create` returns when the machine is
 * registered, not when it's actually ready.
 *
 * `pushDir` uses tar-over-stdin (`tar -c | orbctl run … bash -lc 'tar -x'`)
 * because `orbctl push` does **not** work on `--isolated` VMs — it copies
 * via the host's shared-folder mount, which `--isolated` disables.
 */
export function createOrbExec(vmName: string, defaultUser: string): VMExec {
  let booted = false;

  async function ensureBooted(): Promise<void> {
    if (booted) return;
    const deadline = Date.now() + BOOT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await execa('orbctl', ['run', '-m', vmName, 'true'], {
          stdio: 'ignore',
        });
        booted = true;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, BOOT_POLL_INTERVAL_MS));
      }
    }
    throw new Error(
      `VM ${vmName} did not accept commands within ${BOOT_POLL_TIMEOUT_MS}ms`,
    );
  }

  return {
    async pushDir(localDir, dest): Promise<void> {
      await ensureBooted();
      if (!SAFE_DEST.test(dest)) {
        throw new Error(
          `pushDir: refusing unsafe dest path ${JSON.stringify(dest)}`,
        );
      }
      const home = `/home/${defaultUser}`;
      const fullDest = `${home}/${dest}`;

      const tar = spawn('tar', ['-cC', localDir, '.'], {
        env: {
          ...process.env,
          // Suppresses macOS AppleDouble (._*) metadata files that would
          // otherwise litter the destination directory.
          COPYFILE_DISABLE: '1',
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      });

      const orb = execa(
        'orbctl',
        [
          'run',
          '-m',
          vmName,
          'bash',
          '-lc',
          `mkdir -p '${fullDest}' && tar -xC '${fullDest}'`,
        ],
        {
          input: tar.stdout,
          stdio: ['pipe', 'inherit', 'inherit'],
        },
      );

      const tarExit = new Promise<void>((resolve, reject) => {
        tar.on('error', reject);
        tar.on('exit', (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `tar exited code=${String(code)} signal=${String(signal)}`,
              ),
            );
        });
      });

      await Promise.all([tarExit, orb]);
    },

    async run({ user, argv }): Promise<void> {
      await ensureBooted();
      const orbArgv = ['run', '-m', vmName];
      if (user === 'root') orbArgv.push('-u', 'root');
      orbArgv.push(...argv);
      await execa('orbctl', orbArgv, { stdio: 'inherit' });
    },
  };
}
