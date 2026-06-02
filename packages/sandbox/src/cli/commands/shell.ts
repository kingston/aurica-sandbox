import { spawn } from 'node:child_process';

import { readState } from '#src/state/index.js';

import { resolveTarget } from './find-primary.js';

/**
 * Open an interactive shell into the sandbox VM via the OrbStack `orb` CLI
 * (`orb -m <name>`). When `nameArg` is omitted, targets the project's
 * primary sandbox. Returns the child process exit code.
 */
export async function runShell(
  projectDir: string,
  nameArg?: string,
): Promise<number> {
  const state = await readState();
  const entry = resolveTarget(state, projectDir, nameArg);
  const name = entry.name;
  return new Promise((resolve, reject) => {
    const child = spawn('orb', ['-m', name], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code ?? 0);
    });
  });
}
