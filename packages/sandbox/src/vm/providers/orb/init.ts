import { spawn } from 'node:child_process';
import path from 'node:path';

import { execa } from 'execa';

import type { VMExec } from '#src/vm/init/run-init.js';

const BOOT_POLL_TIMEOUT_MS = 30_000;
const BOOT_POLL_INTERVAL_MS = 500;
// Matches both home-relative (`code/repo`) and absolute (`/workspaces/repo`)
// dest paths. The leading `/` is optional; the rest is the same conservative
// allowlist we use to keep the value safe to single-quote in a bash command.
const SAFE_DEST = /^\/?[A-Za-z0-9._/-]+$/;
// Absolute-only variant for `pushFile`, where a relative path makes no sense
// (the only callers know exactly where the file should land).
const SAFE_ABS_PATH = /^\/[A-Za-z0-9._/-]+$/;

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

  /**
   * Pipe a producer process's stdout into `orbctl run … <consumerScript>`
   * and resolve only when both ends exit cleanly. Used by `pushDir` and
   * `pushFile` to stream tar archives over stdin without buffering them
   * on the host.
   */
  async function streamIntoOrb(
    producer: ReturnType<typeof spawn>,
    consumerScript: string,
    producerLabel: string,
  ): Promise<void> {
    if (!producer.stdout) {
      throw new Error(`${producerLabel}: producer process has no stdout`);
    }
    const orb = execa(
      'orbctl',
      ['run', '-m', vmName, 'bash', '-lc', consumerScript],
      {
        input: producer.stdout,
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    );
    const producerExit = new Promise<void>((resolve, reject) => {
      producer.on('error', reject);
      producer.on('exit', (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `${producerLabel} exited code=${String(code)} signal=${String(signal)}`,
            ),
          );
      });
    });
    await Promise.all([producerExit, orb]);
  }

  return {
    async pushDir(localDir, dest): Promise<void> {
      await ensureBooted();
      if (!SAFE_DEST.test(dest)) {
        throw new Error(
          `pushDir: refusing unsafe dest path ${JSON.stringify(dest)}`,
        );
      }
      // Home-relative paths anchor under `/home/<user>`; absolute paths land
      // exactly where they were requested.
      const fullDest = dest.startsWith('/')
        ? dest
        : `/home/${defaultUser}/${dest}`;

      const tar = spawn('tar', ['--no-mac-metadata', '-cC', localDir, '.'], {
        env: {
          ...process.env,
          // Suppresses macOS AppleDouble (._*) metadata files that would
          // otherwise litter the destination directory.
          COPYFILE_DISABLE: '1',
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      });

      await streamIntoOrb(
        tar,
        `mkdir -p '${fullDest}' && tar -xC '${fullDest}'`,
        'tar',
      );
    },

    async pushFile(localFile, vmAbsPath): Promise<void> {
      await ensureBooted();
      if (!SAFE_ABS_PATH.test(vmAbsPath)) {
        throw new Error(
          `pushFile: refusing unsafe dest path ${JSON.stringify(vmAbsPath)}`,
        );
      }
      const parent = path.posix.dirname(vmAbsPath);
      const targetName = path.posix.basename(vmAbsPath);
      const srcDir = path.dirname(localFile);
      const srcName = path.basename(localFile);

      // Single-file tar: archive just `<srcName>` from its parent directory
      // and extract into the VM's destination parent. If the source and
      // destination names differ, rename after extraction. Preserves mode +
      // mtime; orbctl push isn't usable here (`--isolated` VMs have no
      // shared-folder mount).
      const tar = spawn('tar', ['--no-mac-metadata', '-cC', srcDir, srcName], {
        env: {
          ...process.env,
          COPYFILE_DISABLE: '1',
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      });

      const renameStep =
        srcName === targetName
          ? ''
          : ` && mv '${parent}/${srcName}' '${parent}/${targetName}'`;

      await streamIntoOrb(
        tar,
        `mkdir -p '${parent}' && tar -xC '${parent}'${renameStep}`,
        'tar',
      );
    },

    async run({ user, argv, cwd, env }): Promise<void> {
      await ensureBooted();
      const orbArgv = ['run', '-m', vmName];
      if (user === 'root') orbArgv.push('-u', 'root');
      if (cwd !== undefined) orbArgv.push('-w', cwd);
      if (env) {
        for (const [k, v] of Object.entries(env))
          orbArgv.push('-e', `${k}=${v}`);
      }
      orbArgv.push(...argv);
      await execa('orbctl', orbArgv, { stdio: 'inherit' });
    },
  };
}
