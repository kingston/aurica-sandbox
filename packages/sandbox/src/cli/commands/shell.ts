import { spawn } from 'node:child_process';

import { readState } from '#src/state/index.js';

/**
 * Open an interactive shell into the sandbox VM via the OrbStack `orb` CLI
 * (`orb -m <name>`). Throws if the sandbox is unknown. Returns the child
 * process exit code.
 */
export async function runShell(name: string): Promise<number> {
  const state = await readState();
  const entry = state.sandboxes[name];
  if (!entry) throw new Error(`Sandbox ${name} not found`);
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
