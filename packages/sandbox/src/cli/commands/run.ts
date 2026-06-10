import { readState } from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';
import { assertPlatformSupported } from '#src/vm/platform.js';

import { resolveTarget } from './find-primary.js';
import { ensureProxyRunning } from './proxy.js';

/**
 * Execute `argv` inside the sandbox VM with `HTTP_PROXY` / `HTTPS_PROXY`
 * pointed at the running host proxy. Stdio is inherited; the child's exit
 * code is returned (1 if absent).
 *
 * When `nameArg` is omitted, targets the project's primary sandbox.
 */
export async function runRun(
  projectDir: string,
  nameArg: string | undefined,
  argv: string[],
): Promise<number> {
  if (argv.length === 0) throw new Error('run requires a command after `--`');

  assertPlatformSupported();
  await ensureProxyRunning();
  const state = await readState();
  const entry = resolveTarget(state, projectDir, nameArg);

  return defaultProvider.runOneShot({
    name: entry.name,
    argv,
  });
}
