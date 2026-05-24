import fs from 'node:fs/promises';
import path from 'node:path';

import type { MountEntry } from '#src/config/sandbox.js';

import { expandHostSrc } from './expand-host-src.js';

/**
 * Host-side resolution of a single `mounts[]` entry: the source path
 * made absolute and an optional VM-side destination. orbctl rejects
 * non-directory mount sources, so `absSrc` is guaranteed to be an
 * existing directory by the time this is returned.
 */
export interface ResolvedMount {
  /** Absolute host path of an existing directory. */
  absSrc: string;
  /** Absolute VM path. Omitted -> orbctl mounts at `absSrc` inside the VM. */
  dest?: string;
}

/**
 * Resolve every entry in `entries` against the host filesystem and assert
 * each source is an existing directory. Fails fast before VM creation so
 * a typo in `.aurica/sandbox.json` doesn't leave an orphan VM behind.
 *
 * Returns an array in the same order as `entries`; an empty input yields
 * an empty output.
 */
export async function resolveMounts(
  projectDir: string,
  entries: MountEntry[],
): Promise<ResolvedMount[]> {
  const resolved: ResolvedMount[] = [];
  for (const entry of entries) {
    const absSrc = expandHostSrc(entry.src, projectDir);
    let stat;
    try {
      stat = await fs.stat(absSrc);
    } catch (err) {
      throw new Error(
        `mounts[].src ${JSON.stringify(entry.src)} resolves to ${absSrc} which does not exist or is not accessible`,
        { cause: err },
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `mounts[].src ${JSON.stringify(entry.src)} (${absSrc}) is not a directory; orbctl mounts only accept directories`,
      );
    }
    if (entry.dest !== undefined && !path.isAbsolute(entry.dest)) {
      throw new Error(
        `mounts[].dest ${JSON.stringify(entry.dest)} must be an absolute VM path (start with '/')`,
      );
    }
    const out: ResolvedMount = { absSrc };
    if (entry.dest !== undefined) out.dest = entry.dest;
    resolved.push(out);
  }
  return resolved;
}

/**
 * Format a resolved mount as the value passed to `orbctl create --mount`.
 * Returns `absSrc` when no destination is set, otherwise `absSrc:dest` —
 * matching orbctl's `SOURCE[:DEST]` syntax.
 */
export function formatMountArg(mount: ResolvedMount): string {
  return mount.dest === undefined
    ? mount.absSrc
    : `${mount.absSrc}:${mount.dest}`;
}
