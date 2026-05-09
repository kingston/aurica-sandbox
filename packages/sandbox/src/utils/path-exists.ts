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
