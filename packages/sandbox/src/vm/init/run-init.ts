import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { VMExec } from '#src/vm/types.js';

export type { VMExec };

/**
 * The placeholder string the orchestrator writes into the VM's git config.
 * The host proxy substitutes this at request time. Distinct enough that a
 * grep for it inside the VM will reliably find the surface.
 */
export const GIT_TOKEN_PLACEHOLDER = '__AURICA_GIT_TOKEN__';

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
   * Git config for cloning, or null to skip. The orchestrator never sees the
   * real token — it only knows the placeholder string that the host proxy
   * will substitute on the wire.
   *
   * `placeholder` is optional: when set, a host-level `extraHeader` is
   * written before the clone (the legacy auth path for non-github URLs and
   * unauthenticated cases). When omitted, the caller is expected to have
   * already supplied a more-specific path-prefixed `extraHeader` via
   * `vmGitHeaders` — emitting both would produce duplicate `Authorization`
   * headers on the wire.
   */
  git: { url: string; ref?: string; placeholder?: string } | null;
  /**
   * Post-lockdown commands contributed by plugins, run between the built-in
   * bootstrap and the project-repo clone. Each command picks its own user
   * (`'root'` or `'default'`) and supplies an argv passed straight to
   * `VMExec.run` (no shell). Any tokens or secrets must be encoded as proxy
   * placeholder strings — the host proxy substitutes the real value on the
   * wire.
   *
   * Runs even when there's no project-repo clone, since plugins may install
   * state for repos the user clones later in their init scripts.
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
 * Run the built-in + user + project init layers against a freshly-booted VM,
 * then optionally git-clone the project repo into `~/project`.
 *
 * Order is fixed:
 *  1. built-in (base packages + plugin bootstrap + iptables lockdown) — run as root
 *  2a. plugin commands (post-lockdown) — argv-only, each picks its own user
 *  2b. git clone — run as default user, configured to send a placeholder
 *     Bearer header that the host proxy substitutes
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

  // 2a. Plugin commands. Runs even when there's no project-repo clone
  //     — plugins may install state for repos the user clones manually in
  //     their init scripts.
  for (const cmd of opts.pluginCommands ?? []) {
    await exec.run({ user: cmd.user, argv: cmd.argv });
  }

  // 2b. Git clone.
  if (opts.git) {
    if (opts.git.placeholder !== undefined) {
      const host = new URL(opts.git.url).host;
      const headerKey = `http.https://${host}/.extraHeader`;
      const headerValue = `Authorization: Bearer ${opts.git.placeholder}`;
      await exec.run({
        user: 'default',
        argv: ['git', 'config', '--global', headerKey, headerValue],
      });
    }
    const cloneArgv = ['git', 'clone'];
    if (opts.git.ref) cloneArgv.push('--branch', opts.git.ref);
    cloneArgv.push(opts.git.url, `/home/${opts.user}/project`);
    await exec.run({ user: 'default', argv: cloneArgv });
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
