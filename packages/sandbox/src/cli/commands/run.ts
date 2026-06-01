import { readState } from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';

import { ensureProxyRunning } from './proxy.js';

/**
 * Execute `argv` inside the sandbox VM with `HTTP_PROXY` / `HTTPS_PROXY`
 * pointed at the running host proxy. Stdio is inherited; the child's exit
 * code is returned (1 if absent).
 */
export async function runRun(name: string, argv: string[]): Promise<number> {
  if (argv.length === 0) throw new Error('run requires a command after `--`');

  await ensureProxyRunning();
  const state = await readState();
  if (!state.sandboxes[name]) {
    throw new Error(`Sandbox ${name} not found`);
  }

  return defaultProvider.runOneShot({
    name,
    argv,
  });
}
