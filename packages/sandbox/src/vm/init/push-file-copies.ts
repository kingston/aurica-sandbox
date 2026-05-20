import path from 'node:path';

import type { VMExec } from '#src/vm/types.js';

import type { ResolvedFileCopy } from './resolve-file-copies.js';

/**
 * Compute the absolute path inside the VM where a `files[]` entry should
 * land. A leading `~/` anchors at the default user's home; anything else
 * is resolved relative to `projectCwd` (the same directory
 * `setup-project.sh` runs in, set by the github plugin or defaulting to
 * `/workspaces`).
 */
export function resolveVmDest(
  dest: string,
  user: string,
  projectCwd: string,
): string {
  if (dest === '~' || dest.startsWith('~/')) {
    const rest = dest === '~' ? '' : dest.slice(2);
    return path.posix.join(`/home/${user}`, rest);
  }
  if (path.posix.isAbsolute(dest)) {
    return dest;
  }
  return path.posix.join(projectCwd, dest);
}

/**
 * Push every resolved entry into the VM. Files use `pushFile` (single-file
 * tar-over-stdin, preserving mode); directories use `pushDir`. Runs
 * sequentially — the volume is expected to be small (handfuls of files,
 * not thousands) and serial output is easier to follow than interleaved
 * spinners.
 *
 * Aborts on the first failure. The caller surfaces this to the user the
 * same way an init-script failure would.
 */
export async function pushFileCopies(
  exec: VMExec,
  user: string,
  projectCwd: string,
  copies: ResolvedFileCopy[],
): Promise<void> {
  for (const entry of copies) {
    const vmDest = resolveVmDest(entry.dest, user, projectCwd);
    await (entry.isFile
      ? exec.pushFile(entry.absSrc, vmDest)
      : exec.pushDir(entry.absSrc, vmDest));
  }
}
