import fs from 'node:fs/promises';

/**
 * Returns true if a filesystem entry exists at `p` and is accessible to the
 * current process. Uses `fs.access` and treats any error as non-existence.
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns `p` if it exists and is a directory, otherwise `null`. Any stat
 * error (including a non-existent path) is treated as `null`.
 */
export async function statDirOrNull(p: string): Promise<string | null> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory() ? p : null;
  } catch {
    return null;
  }
}
