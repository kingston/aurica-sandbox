import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { VMExec } from '#src/vm/types.js';

export type { VMExec };

const STAGING_DIR = '.aurica-init-staging';

/** Inputs to {@link runInitPipeline}. */
export interface InitPipelineOptions {
  /**
   * Default Linux user inside the VM. Used to construct the home-relative
   * staging path and to decide which `bash` we're invoking.
   */
  user: string;
  /** Built-in bootstrap script content (from `createInitShell`). */
  builtinScript: string;
  /** Host path to `~/.aurica/sandbox/init`, or null if absent. */
  userInitDir: string | null;
  /** Host path to `<projectDir>/.aurica/init`, or null if absent. */
  projectInitDir: string | null;
  /**
   * Post-lockdown commands contributed by plugins, run between the built-in
   * bootstrap and the user/project init hooks. Each command picks its own
   * user (`'root'` or `'default'`) and supplies an argv passed straight to
   * `VMExec.run` (no shell). Any tokens or secrets must be encoded as proxy
   * placeholder strings — the host proxy substitutes the real value on the
   * wire.
   */
  pluginCommands?: { user: 'root' | 'default'; argv: string[] }[];
}

async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function fileExistsIn(dir: string, name: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, name));
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Run the built-in + plugin + user + project init layers against a
 * freshly-booted VM.
 *
 * Order is fixed:
 *  1. built-in (base packages + plugin bootstrap + iptables lockdown) — run as root
 *  2. plugin commands (post-lockdown) — argv-only, each picks its own user
 *  3. user-level setup-root.sh / setup-user.sh (each only if present)
 *  4. project-level setup-root.sh / setup-user.sh (each only if present)
 *  5. cleanup of the staging directory
 *
 * Aborts on the first non-zero exit. The caller is expected to record
 * `status: 'failed-init'` and rethrow.
 */
export async function runInitPipeline(
  exec: VMExec,
  opts: InitPipelineOptions,
): Promise<void> {
  const stagingHome = `/home/${opts.user}/${STAGING_DIR}`;

  // 1. Built-in bootstrap.
  await withTempDir('aurica-init-builtin-', async (dir) => {
    await fs.writeFile(path.join(dir, 'builtin.sh'), opts.builtinScript, {
      mode: 0o755,
    });
    await exec.pushDir(dir, `${STAGING_DIR}/builtin`);
    await exec.run({
      user: 'root',
      argv: ['bash', `${stagingHome}/builtin/builtin.sh`],
    });
  });

  // 2. Plugin commands.
  for (const cmd of opts.pluginCommands ?? []) {
    await exec.run({ user: cmd.user, argv: cmd.argv });
  }

  // 3 & 4. User and project hooks.
  await runHookLayer(exec, opts.user, 'user', opts.userInitDir);
  await runHookLayer(exec, opts.user, 'project', opts.projectInitDir);

  // 5. Cleanup staging dir. Best-effort: a failure here doesn't change the
  //    correctness of the bootstrap, so we don't gate success on it.
  try {
    await exec.run({
      user: 'root',
      argv: ['rm', '-rf', stagingHome],
    });
  } catch {
    /* ignore */
  }
}

async function runHookLayer(
  exec: VMExec,
  vmUser: string,
  layer: 'user' | 'project',
  dir: string | null,
): Promise<void> {
  if (!dir) return;
  const hasRoot = await fileExistsIn(dir, 'setup-root.sh');
  const hasUser = await fileExistsIn(dir, 'setup-user.sh');
  if (!hasRoot && !hasUser) return;

  await exec.pushDir(dir, `${STAGING_DIR}/${layer}`);
  const stagingPath = `/home/${vmUser}/${STAGING_DIR}/${layer}`;
  if (hasRoot) {
    await exec.run({
      user: 'root',
      argv: ['bash', `${stagingPath}/setup-root.sh`],
    });
  }
  if (hasUser) {
    await exec.run({
      user: 'default',
      argv: ['bash', `${stagingPath}/setup-user.sh`],
    });
  }
}
