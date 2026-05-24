import fs from 'node:fs/promises';
import path from 'node:path';

import type { VMExec } from '#src/vm/types.js';

const STAGING_DIR = '.aurica-init-staging';
const DEFAULT_PROJECT_CWD = '/workspaces';

/** Inputs to {@link runUpdateHooks}. */
export interface UpdateHooksOptions {
  /** Default Linux user inside the VM. */
  user: string;
  /** Name of the sandbox being updated. Passed to hooks as `SANDBOX_NAME`. */
  sandboxName: string;
  /** Whether the target is a primary or fork. Passed as `SANDBOX_KIND`. */
  sandboxKind: 'primary' | 'fork';
  /**
   * Name of the project's primary VM. For forks, this is the parent; for
   * primaries, it equals {@link sandboxName}. Passed as `PRIMARY_NAME`.
   */
  primaryName: string;
  /** Host path to `~/.aurica/sandbox/init`, or null if absent. */
  userInitDir: string | null;
  /** Host path to `<projectDir>/.aurica/init`, or null if absent. */
  projectInitDir: string | null;
  /**
   * Working directory for the project-level `update.sh`. Defaults to
   * `/workspaces`. Plugins like `github` set this to the primary checkout
   * path so hooks land inside the repo.
   */
  projectInitCwdOverride?: string;
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
 * Run `update.sh` hook scripts (user-level then project-level) against an
 * existing sandbox VM. Used by the `update` command to refresh a sandbox
 * without rebuilding (e.g. `git pull`, `pnpm install`).
 *
 * Env vars injected into every hook:
 *   - `SANDBOX_NAME` — the VM being updated
 *   - `SANDBOX_KIND` — `'primary'` or `'fork'`
 *   - `PRIMARY_NAME` — for forks, the parent; for primaries, equal to `SANDBOX_NAME`
 *
 * Both hooks run as the default user under `bash -l` (login shell) so
 * mise-managed tools are on PATH. The project-level hook uses
 * {@link UpdateHooksOptions.projectInitCwdOverride} as its cwd (defaults to
 * `/workspaces`).
 *
 * Returns `true` if at least one hook ran, `false` if neither hook existed —
 * callers can use this to log a "no update hooks found" message.
 *
 * Aborts on the first non-zero exit so the caller can surface the failure.
 */
export async function runUpdateHooks(
  exec: VMExec,
  opts: UpdateHooksOptions,
): Promise<boolean> {
  const stagingHome = `/home/${opts.user}/${STAGING_DIR}`;
  const projectCwd = opts.projectInitCwdOverride ?? DEFAULT_PROJECT_CWD;

  const hookEnv: Record<string, string> = {
    SANDBOX_NAME: opts.sandboxName,
    SANDBOX_KIND: opts.sandboxKind,
    PRIMARY_NAME: opts.primaryName,
  };

  let ranAny = false;
  ranAny =
    (await runUpdateLayer(
      exec,
      'user-update',
      opts.userInitDir,
      projectCwd,
      hookEnv,
      stagingHome,
    )) || ranAny;
  ranAny =
    (await runUpdateLayer(
      exec,
      'project-update',
      opts.projectInitDir,
      projectCwd,
      hookEnv,
      stagingHome,
    )) || ranAny;

  // Best-effort staging cleanup.
  try {
    await exec.run({ user: 'root', argv: ['rm', '-rf', stagingHome] });
  } catch {
    /* ignore */
  }

  return ranAny;
}

async function runUpdateLayer(
  exec: VMExec,
  layerKey: string,
  dir: string | null,
  projectCwd: string,
  hookEnv: Record<string, string>,
  stagingHome: string,
): Promise<boolean> {
  if (!dir) return false;
  const hasHook = await fileExistsIn(dir, 'update.sh');
  if (!hasHook) return false;

  await exec.pushDir(dir, `${STAGING_DIR}/${layerKey}`);
  const stagingPath = `${stagingHome}/${layerKey}`;
  await exec.run({
    user: 'default',
    cwd: projectCwd,
    env: hookEnv,
    argv: ['bash', '-l', `${stagingPath}/update.sh`],
  });
  return true;
}
