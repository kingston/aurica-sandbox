import fs from 'node:fs/promises';

import type { FileCopyEntry } from '#src/config/sandbox.js';

import { expandHostSrc } from './expand-host-src.js';

/**
 * Host-side resolution of a single `files[]` entry: the source path made
 * absolute, whether it's a file or a directory, and the verbatim
 * destination string from the config (resolved to an absolute VM path
 * later, when we know `projectCwd` and the VM user).
 */
export interface ResolvedFileCopy {
  /** Absolute host path. */
  absSrc: string;
  /** True when the source is a single file; false when it's a directory. */
  isFile: boolean;
  /** Destination string straight from the config (post-validation). */
  dest: string;
}

/**
 * Resolve every entry in `entries` against the host filesystem and stat
 * the result. Fails fast with a clear message if any source is missing or
 * inaccessible — callers (notably `runCreate`) invoke this before the VM
 * is created so a typo in `.aurica/sandbox.json` doesn't leave an orphan
 * VM behind.
 *
 * Returns an array in the same order as `entries`; an empty input yields
 * an empty output.
 */
export async function resolveFileCopies(
  projectDir: string,
  entries: FileCopyEntry[],
): Promise<ResolvedFileCopy[]> {
  const resolved: ResolvedFileCopy[] = [];
  for (const entry of entries) {
    const absSrc = expandHostSrc(entry.src, projectDir);
    let stat;
    try {
      stat = await fs.stat(absSrc);
    } catch (err) {
      throw new Error(
        `files[].src ${JSON.stringify(entry.src)} resolves to ${absSrc} which does not exist or is not accessible`,
        { cause: err },
      );
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(
        `files[].src ${JSON.stringify(entry.src)} (${absSrc}) is neither a regular file nor a directory`,
      );
    }
    resolved.push({
      absSrc,
      isFile: stat.isFile(),
      dest: entry.dest,
    });
  }
  return resolved;
}
