import { readState } from './store.js';

/** Thrown by `requireRunningProxy` when no live proxy PID is recorded. */
export class ProxyNotRunningError extends Error {
  constructor() {
    super(
      'aurica-sandbox proxy is not running. Start it with: aurica-sandbox proxy',
    );
    this.name = 'ProxyNotRunningError';
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Send SIGHUP to the running proxy so it re-reads `state.json`.
 * Silently no-ops if no proxy is registered or the recorded PID is dead —
 * the caller is responsible for failing earlier if a live proxy is required.
 */
export async function signalProxyReload(): Promise<void> {
  const state = await readState();
  const pid = state.proxy?.pid;
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGHUP');
    } catch {
      /* race: process exited between alive check and kill */
    }
  }
}

/**
 * Return the recorded proxy entry, or throw `ProxyNotRunningError` if there
 * is no live proxy. Use before any command that depends on the proxy being
 * up.
 */
export async function requireRunningProxy(): Promise<{
  pid: number;
  host: string;
  port: number;
}> {
  const state = await readState();
  if (!state.proxy || !isPidAlive(state.proxy.pid)) {
    throw new ProxyNotRunningError();
  }
  return state.proxy;
}
