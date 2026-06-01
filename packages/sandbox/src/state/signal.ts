import { readState } from './store.js';

/** Thrown by `requireRunningProxy` when no live proxy PID is recorded. */
export class ProxyNotRunningError extends Error {
  constructor() {
    super(
      'aurica-sandbox proxy is not running. Start it with: aurica-sandbox proxy start',
    );
    this.name = 'ProxyNotRunningError';
  }
}

/**
 * Check whether a process with the given PID is alive.
 *
 * Uses `process.kill(pid, 0)`: on POSIX, signal 0 doesn't terminate the
 * process but probes for its existence and our permission to signal it. If the
 * process doesn't exist, `ESRCH` is thrown (dead); if it exists but we lack
 * permission, `EPERM` is thrown (still alive). Returns true when the process is
 * running or merely inaccessible to us.
 */
export function isPidAlive(pid: number): boolean {
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
 * Send SIGTERM to the running proxy so it shuts down cleanly (its handler
 * tears down the proxy and clears `state.proxy`). Returns the PID signalled, or
 * null if no live proxy is recorded. The caller is responsible for waiting for
 * `state.proxy` to clear and escalating to SIGKILL if it doesn't.
 */
export async function signalProxyStop(): Promise<number | null> {
  const state = await readState();
  const pid = state.proxy?.pid;
  if (!pid || !isPidAlive(pid)) return null;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* race: process exited between alive check and kill */
    return null;
  }
  return pid;
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
