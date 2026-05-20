import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { VMExec } from '#src/vm/types.js';

import { pushFileCopies } from './push-file-copies.js';
import type { ResolvedFileCopy } from './resolve-file-copies.js';

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
  /**
   * Override for the working directory the project-level init hook
   * (`setup-project.sh`) runs from. Defaults to `/workspaces` (created by
   * the built-in init script). Plugins like `github` set this to the
   * primary checkout path so `setup-project.sh` lands inside the repo.
   *
   * Project-related environment variables (e.g. `AURICA_PROJECT_DIR`) are
   * not passed here. Plugins write them into `/etc/environment` via a
   * root post-lockdown command so every PAM-launched shell — including
   * this hook — sees them.
   */
  projectInitCwdOverride?: string;
  /**
   * Pre-resolved host files/directories to copy into the VM. Runs after
   * the built-in bootstrap but before plugin commands and user/project
   * hooks, so hooks can read the copied files (e.g. source a `.env`).
   * Destinations without a `~/` prefix land under the same `projectCwd`
   * used for `setup-project.sh`.
   */
  fileCopies?: ResolvedFileCopy[];
}

const DEFAULT_PROJECT_INIT_CWD = '/workspaces';

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
 *  2. file copies (host -> VM, post-lockdown) — config `files[]`
 *  3. plugin commands (post-lockdown) — argv-only, each picks its own user
 *  4. user-level setup-root.sh / setup-user.sh / setup-project.sh
 *  5. project-level setup-root.sh / setup-user.sh / setup-project.sh
 *  6. cleanup of the staging directory
 *
 * Each script within a layer is run only if it exists. `setup-project.sh`
 * additionally requires `projectInitContext` to be set — the script only
 * makes sense in the context of a checked-out project (today: the github
 * plugin's primary repo).
 *
 * Aborts on the first non-zero exit. The caller is expected to record
 * `status: 'failed-init'` and rethrow.
 */
export async function runInitPipeline(
  exec: VMExec,
  opts: InitPipelineOptions,
): Promise<void> {
  const stagingHome = `/home/${opts.user}/${STAGING_DIR}`;
  const projectCwd = opts.projectInitCwdOverride ?? DEFAULT_PROJECT_INIT_CWD;

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

  // 2. File copies (host -> VM). Sits between the built-in bootstrap and
  //    plugin commands so plugin commands AND every hook layer can read
  //    the copied files. The lockdown step has already run inside the
  //    bootstrap, but copies travel over the orbctl control channel, not
  //    the VM's network — iptables doesn't apply.
  if (opts.fileCopies && opts.fileCopies.length > 0) {
    await pushFileCopies(exec, opts.user, projectCwd, opts.fileCopies);
  }

  // 3. Plugin commands (post-lockdown, post-file-copy).
  for (const cmd of opts.pluginCommands ?? []) {
    await exec.run({ user: cmd.user, argv: cmd.argv });
  }

  // 4 & 5. User and project hooks.
  await runHookLayer(exec, opts.user, 'user', opts.userInitDir, projectCwd);
  await runHookLayer(
    exec,
    opts.user,
    'project',
    opts.projectInitDir,
    projectCwd,
  );

  // 6. Cleanup staging dir. Best-effort: a failure here doesn't change the
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
  projectCwd: string,
): Promise<void> {
  if (!dir) return;
  const hasRoot = await fileExistsIn(dir, 'setup-root.sh');
  const hasUser = await fileExistsIn(dir, 'setup-user.sh');
  const hasProject = await fileExistsIn(dir, 'setup-project.sh');
  if (!hasRoot && !hasUser && !hasProject) return;

  await exec.pushDir(dir, `${STAGING_DIR}/${layer}`);
  const stagingPath = `/home/${vmUser}/${STAGING_DIR}/${layer}`;
  // All hooks run under `bash -l` (login shell). Login mode sources
  // `/etc/profile` + `~/.profile`, which on Ubuntu/Debian chain into
  // `~/.bashrc` — so plugin-installed shell integrations like
  // `eval "$(mise activate bash)"` fire, putting mise-managed tools
  // (`pnpm`, `node`, …) on PATH for the hook script. Without `-l`, hooks
  // run as plain non-interactive non-login shells and only see the
  // skeletal PATH inherited from the orchestrator.
  if (hasRoot) {
    // System packages and root configuration. No project cwd — root hooks
    // aren't tied to any project.
    await exec.run({
      user: 'root',
      argv: ['bash', '-l', `${stagingPath}/setup-root.sh`],
    });
  }
  if (hasUser) {
    // User-global config (dotfiles, shell setup, etc.) that should apply
    // regardless of whether a project is checked out. Runs from the
    // default user's $HOME.
    await exec.run({
      user: 'default',
      argv: ['bash', '-l', `${stagingPath}/setup-user.sh`],
    });
  }
  if (hasProject) {
    // Project-specific setup (dependency install, project-local tools).
    // Runs with cwd = projectCwd via the provider's `run.cwd` option —
    // defaults to `/workspaces` when no plugin overrides it. Project env
    // vars (e.g. `AURICA_PROJECT_DIR`) reach this hook via
    // `/etc/environment`, not via an `env` prefix here.
    await exec.run({
      user: 'default',
      cwd: projectCwd,
      argv: ['bash', '-l', `${stagingPath}/setup-project.sh`],
    });
  }
}
