import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { proxyLogPath, proxyLogRotatedPath } from '#src/config/index.js';
import { logger } from '#src/logger.js';
import { resolvedProxyPort, runProxyProcess } from '#src/proxy/index.js';
import {
  isPidAlive,
  readState,
  requireRunningProxy,
  signalProxyStop,
  withState,
} from '#src/state/index.js';

/** How long `start`/`stop` wait for `state.proxy` to settle before giving up. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Poll interval while waiting on the readiness/shutdown handshake. */
const HANDSHAKE_POLL_MS = 100;
/**
 * Grace period after the daemon claims `state.proxy` before declaring success,
 * giving a sidecar that crashes just after the claim time to exit so `start`
 * reports the failure rather than a false "started".
 */
const HANDSHAKE_GRACE_MS = 300;
/** Lines of the log shown when a daemon fails to come up. */
const CRASH_LOG_LINES = 20;
/**
 * How long autostart polls for a racing winner's proxy after its own start
 * fails. Short so a genuine boot failure isn't masked by a long wait.
 */
const RACE_ADOPT_MS = 2000;

/** A live proxy registration: its PID and listen address. */
export interface ProxyEndpoint {
  pid: number;
  host: string;
  port: number;
}

/** Options shared by the foreground and background proxy entry points. */
export interface ProxyRunOptions {
  /** Log a verbose decision line for every request (see `runProxyProcess`). */
  verbose?: boolean;
}

/** Options for {@link runProxyStart}. */
export interface ProxyStartOptions extends ProxyRunOptions {
  /**
   * Suppress the `proxy started` success line. Used by autostart, which logs
   * its own message instead.
   */
  quiet?: boolean;
}

/**
 * Thrown by {@link runProxyStart} when a live proxy already holds `state.proxy`.
 * Autostart treats this as success (another process won the race).
 */
export class ProxyAlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(
      `aurica-sandbox proxy already running (pid ${pid}); stop it with: aurica-sandbox proxy stop`,
    );
    this.name = 'ProxyAlreadyRunningError';
  }
}

/**
 * Thrown when the daemon dies because its port is already bound but no tracked
 * proxy owns it (an untracked orphan, or an unrelated process). `proxy stop`
 * can't help — it reads the dead recorded pid — so the guidance is to retry
 * (a leftover aurica proxy self-heals `state.proxy` within seconds) or free the
 * port.
 */
export class ProxyPortInUseError extends Error {
  constructor(public readonly port: number) {
    super(
      `port ${port} is in use but no tracked proxy owns it.\n` +
        `If a leftover aurica-sandbox proxy is still running, it will re-register within a few seconds — retry your command.\n` +
        `Otherwise free port ${port} or set AURICA_PROXY_PORT to an open port.`,
    );
    this.name = 'ProxyPortInUseError';
  }
}

/**
 * Thrown when the daemon dies because the OS denied binding the port
 * (`EACCES`) — typically a privileged port (< 1024) the user can't claim.
 */
export class ProxyPortPermissionError extends Error {
  constructor(public readonly port: number) {
    super(
      `permission denied binding port ${port}.\n` +
        `Ports below 1024 require elevated privileges — set AURICA_PROXY_PORT to a port >= 1024.`,
    );
    this.name = 'ProxyPortPermissionError';
  }
}

/** A spawn recipe for the detached daemon, separated out so it can be tested. */
export interface DaemonSpawn {
  command: string;
  args: string[];
  /** Passed to `spawn`; `stdio` is filled in by the caller with the log fd. */
  options: {
    detached: true;
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
}

/**
 * Compute the argv and spawn options for the detached proxy daemon. The child
 * re-execs this same CLI as `proxy run`.
 *
 * `process.execArgv` is spread ahead of the script path so loader flags (e.g.
 * the tsx hooks used in dev) survive the re-exec; `env` and `cwd` are inherited
 * so `AURICA_PROXY_PORT` / `AURICA_HOME` carry over and the daemon loads
 * `.aurica/.env` from the same project directory the user launched it in.
 *
 * Kept pure (no spawning, no fd handling) so callers can assert the argv shape
 * without actually detaching a process.
 */
export function buildDaemonSpawn(options: ProxyRunOptions = {}): DaemonSpawn {
  const args = [
    ...process.execArgv,
    process.argv[1] ?? '',
    'proxy',
    'run',
    ...(options.verbose === true ? ['-v'] : []),
  ];
  return {
    command: process.argv[0] ?? process.execPath,
    args,
    options: {
      detached: true,
      cwd: process.cwd(),
      env: process.env,
    },
  };
}

/**
 * Run the proxy in the foreground (today's `aurica-sandbox proxy` behavior):
 * boot it, then block forever so the process stays alive. SIGINT/SIGTERM are
 * handled inside `runProxyProcess` for a clean shutdown.
 */
export async function runProxyRun(
  options: ProxyRunOptions = {},
): Promise<void> {
  await runProxyProcess({ verbose: options.verbose === true });
  await new Promise<never>(() => {
    /* run forever */
  });
}

/** Rotate `proxy.log` aside (best effort) so a fresh log starts each daemon. */
async function rotateLog(): Promise<void> {
  try {
    await fs.rename(proxyLogPath(), proxyLogRotatedPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Read the last `lines` lines of the proxy log, or '' if it can't be read. */
async function tailLogText(lines: number): Promise<string> {
  try {
    const raw = await fs.readFile(proxyLogPath(), 'utf8');
    return raw.split('\n').slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}

/**
 * Translate a dead daemon's log tail into the most actionable error available.
 * Common bind failures (`EADDRINUSE`, `EACCES`) have specific recovery stories,
 * so they're mapped to dedicated errors; anything else falls back to a log dump
 * pointing at `logPath`. The tail is this boot's log (`rotateLog` ran first) and
 * consola logs bind failures as `listen EADDRINUSE …` / `listen EACCES …`, so a
 * substring match is the available signal. Pure (no I/O) so it's unit-testable.
 */
export function classifyDaemonCrash(
  tail: string,
  port: number,
  childPid: number,
  logPath: string,
): Error {
  if (tail.includes('EADDRINUSE')) return new ProxyPortInUseError(port);
  if (tail.includes('EACCES')) return new ProxyPortPermissionError(port);
  const detail = tail ? `\n--- ${logPath} ---\n${tail}` : '';
  return new Error(
    `proxy daemon did not come up (pid ${childPid}); see ${logPath}${detail}`,
  );
}

/**
 * Start the proxy as a detached background daemon. Refuses if a live proxy
 * already holds `state.proxy` (the proxy is a host-wide singleton). Output is
 * redirected to {@link proxyLogPath}, rotated aside on each start.
 *
 * Waits for the daemon to claim `state.proxy` (written only after it's
 * listening) before reporting success — if the child dies first, its log tail
 * is surfaced as the failure rather than reporting a false success.
 */
export async function runProxyStart(
  options: ProxyStartOptions = {},
): Promise<ProxyEndpoint> {
  const existing = await readState();
  if (existing.proxy && isPidAlive(existing.proxy.pid)) {
    throw new ProxyAlreadyRunningError(existing.proxy.pid);
  }

  const logPath = proxyLogPath();
  // The daemon writes `state.proxy` (and thus creates `stateDir`) only after it
  // boots, so ensure the directory exists before opening the log here.
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await rotateLog();
  // Open append so the daemon's stdout+stderr both land in the same file;
  // crashes/uncaught errors that bypass consola are captured too.
  const logHandle = await fs.open(logPath, 'a');
  let child: ChildProcess;
  try {
    const recipe = buildDaemonSpawn(options);
    child = spawn(recipe.command, recipe.args, {
      ...recipe.options,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
    child.unref();
  } finally {
    await logHandle.close();
  }

  const childPid = child.pid;
  if (childPid === undefined) {
    throw new Error('failed to spawn proxy daemon (no pid)');
  }

  const ready = await waitForProxyReady(childPid);
  // The daemon claims `state.proxy` once it's listening but then starts plugin
  // sidecars, which can still throw and crash it. Re-check liveness after a
  // short grace so a crash-after-claim is reported as a failure rather than a
  // false "started".
  if (ready) {
    await delay(HANDSHAKE_GRACE_MS);
    if (!isPidAlive(childPid)) {
      await withState((state) => {
        if (state.proxy?.pid === childPid) state.proxy = null;
      });
    }
  }
  if (!ready || !isPidAlive(childPid)) {
    const tail = await tailLogText(CRASH_LOG_LINES);
    throw classifyDaemonCrash(tail, resolvedProxyPort(), childPid, logPath);
  }

  if (options.quiet !== true) {
    logger.success(
      `proxy started (pid ${ready.pid}) http://${ready.host}:${ready.port}\nlogs: ${logPath}`,
    );
  }
  return ready;
}

/** Env var that, when set to `1`/`true`, disables proxy autostart. */
const NO_AUTOSTART_ENV = 'AURICA_NO_AUTOSTART';

/** Whether `value` is an opt-in flag value (`1`/`true`, case-insensitive). */
function isEnvEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * Return the running proxy, autostarting it as a background daemon if none is
 * live. Commands that require a proxy call this instead of `requireRunningProxy`
 * so the user doesn't have to start the daemon by hand.
 *
 * Set `AURICA_NO_AUTOSTART=1` to opt out — then this behaves like
 * `requireRunningProxy`, throwing `ProxyNotRunningError` when nothing is up
 * (useful in CI, where a leaked host-wide daemon would be surprising).
 *
 * Concurrency: if two commands autostart at once, only one wins the port. The
 * loser's child dies on the port bind — which happens before the winner claims
 * `state.proxy` — so on failure we briefly poll for a live registration and
 * adopt the winner's daemon rather than erroring.
 */
export async function ensureProxyRunning(): Promise<ProxyEndpoint> {
  const state = await readState();
  if (state.proxy && isPidAlive(state.proxy.pid)) return state.proxy;

  if (isEnvEnabled(process.env[NO_AUTOSTART_ENV])) {
    // Opted out: surface the same error a bare `requireRunningProxy` would.
    return requireRunningProxy();
  }

  // Notice goes to stderr so it never pollutes a piped `run` command's stdout.
  process.stderr.write('proxy not running; starting it in the background…\n');
  try {
    return await runProxyStart({ quiet: true });
  } catch (err) {
    // The bind that failed us happens before the winner's state claim, so a
    // racing winner may still be mid-boot. Poll briefly for any live proxy and
    // adopt it. Capped short so a genuine single-command boot failure (e.g. an
    // unrelated process holding the port) surfaces its real error promptly
    // rather than after the full handshake timeout.
    const deadline = Date.now() + RACE_ADOPT_MS;
    while (Date.now() < deadline) {
      const after = await readState();
      if (after.proxy && isPidAlive(after.proxy.pid)) return after.proxy;
      await delay(HANDSHAKE_POLL_MS);
    }
    throw err;
  }
}

/**
 * Poll `state.proxy` until the daemon with `childPid` has claimed it and is
 * alive, returning the recorded entry. Resolves null on timeout or if the
 * child dies before claiming (e.g. port busy, mockttp reject).
 */
async function waitForProxyReady(
  childPid: number,
): Promise<{ pid: number; host: string; port: number } | null> {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(childPid)) return null;
    const state = await readState();
    if (state.proxy?.pid === childPid && isPidAlive(state.proxy.pid)) {
      return state.proxy;
    }
    await delay(HANDSHAKE_POLL_MS);
  }
  return null;
}

/** Options for {@link runProxyStop}. */
export interface ProxyStopOptions {
  /**
   * How long to wait for a clean SIGTERM shutdown before escalating to SIGKILL.
   * Defaults to {@link HANDSHAKE_TIMEOUT_MS}; lowered in tests to exercise the
   * escalation path without a long wall-clock wait.
   */
  timeoutMs?: number;
}

/**
 * Stop the running proxy daemon. Sends SIGTERM (its handler tears the proxy
 * down and clears `state.proxy`), waits for the entry to clear, then escalates
 * to SIGKILL — clearing `state.proxy` manually in that case since SIGKILL skips
 * the clean-shutdown path. Throws `ProxyNotRunningError` if no live proxy.
 */
export async function runProxyStop(
  options: ProxyStopOptions = {},
): Promise<void> {
  const { pid } = await requireRunningProxy();
  await signalProxyStop();

  const deadline = Date.now() + (options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const state = await readState();
    if (!state.proxy || state.proxy.pid !== pid || !isPidAlive(pid)) {
      logger.success('proxy stopped');
      return;
    }
    await delay(HANDSHAKE_POLL_MS);
  }

  // Clean shutdown didn't complete in time — force it.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  await withState((state) => {
    if (state.proxy?.pid === pid) state.proxy = null;
  });
  logger.warn(`proxy did not stop cleanly; killed pid ${pid}`);
}
