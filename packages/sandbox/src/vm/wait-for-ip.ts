import { orbProvider } from '#src/vm/index.js';
import type { SandboxVM } from '#src/vm/types.js';

/**
 * Poll `orbProvider.infoVM(name)` until the VM reports an IPv4 address or
 * `timeoutMs` elapses. Returns the latest `SandboxVM` either way — callers
 * are expected to check `networkInfo?.ipV4` and treat its absence as
 * "no IP within the deadline".
 */
export async function waitForIp(
  name: string,
  timeoutMs = 30_000,
): Promise<SandboxVM> {
  const deadline = Date.now() + timeoutMs;
  let last: SandboxVM = await orbProvider.infoVM(name);
  while (!last.networkInfo?.ipV4 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    last = await orbProvider.infoVM(name);
  }
  return last;
}
