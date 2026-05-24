import os from 'node:os';
import path from 'node:path';

/**
 * Expand a host-side `src` string into an absolute path.
 *
 * - A leading `~/` (or bare `~`) expands against the host user's home.
 * - An absolute path is returned unchanged.
 * - Anything else is resolved against `projectDir`.
 */
export function expandHostSrc(src: string, projectDir: string): string {
  if (src === '~' || src.startsWith('~/')) {
    const rest = src === '~' ? '' : src.slice(2);
    return path.join(os.homedir(), rest);
  }
  if (path.isAbsolute(src)) {
    return src;
  }
  return path.resolve(projectDir, src);
}
