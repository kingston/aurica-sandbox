import { execa } from 'execa';

import { readState, requireRunningProxy } from '#src/state/index.js';

/**
 * Execute `argv` inside the sandbox VM with `HTTP_PROXY` / `HTTPS_PROXY`
 * pointed at the running host proxy. Stdio is inherited; the child's exit
 * code is returned (1 if absent).
 */
export async function runRun(name: string, argv: string[]): Promise<number> {
  if (argv.length === 0) throw new Error('run requires a command after `--`');

  const proxy = await requireRunningProxy();
  const state = await readState();
  if (!state.sandboxes[name]) {
    throw new Error(`Sandbox ${name} not found`);
  }

  const proxyUrl = `http://${proxy.host}:${proxy.port}`;
  const envArgs = [
    '-e',
    `HTTP_PROXY=${proxyUrl}`,
    '-e',
    `HTTPS_PROXY=${proxyUrl}`,
  ];

  const result = await execa(
    'orbctl',
    ['run', '-m', name, ...envArgs, '--', ...argv],
    { reject: false, stdio: 'inherit' },
  );
  return result.exitCode ?? 1;
}
