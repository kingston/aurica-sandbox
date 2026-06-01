import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';

import { proxyLogPath, proxyLogRotatedPath } from '#src/config/index.js';
import { logger } from '#src/logger.js';
import { runProxyProcess } from '#src/proxy/index.js';
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

/** Options shared by the foreground and background proxy entry points. */
export interface ProxyRunOptions {
  /** Log a verbose decision line for every request (see `runProxyProcess`). */
  verbose?: boolean;
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
 * Start the proxy as a detached background daemon. Refuses if a live proxy
 * already holds `state.proxy` (the proxy is a host-wide singleton). Output is
 * redirected to {@link proxyLogPath}, rotated aside on each start.
 *
 * Waits for the daemon to claim `state.proxy` (written only after it's
 * listening) before reporting success — if the child dies first, its log tail
 * is surfaced as the failure rather than reporting a false success.
 */
export async function runProxyStart(
  options: ProxyRunOptions = {},
): Promise<void> {
  const existing = await readState();
  if (existing.proxy && isPidAlive(existing.proxy.pid)) {
    throw new Error(
      `aurica-sandbox proxy already running (pid ${existing.proxy.pid}); stop it with: aurica-sandbox proxy stop`,
    );
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
    const detail = tail ? `\n--- ${logPath} ---\n${tail}` : '';
    throw new Error(
      `proxy daemon did not come up (pid ${childPid}); see ${logPath}${detail}`,
    );
  }

  logger.success(
    `proxy started (pid ${ready.pid}) http://${ready.host}:${ready.port}\nlogs: ${logPath}`,
  );
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

/**
 * Stop the running proxy daemon. Sends SIGTERM (its handler tears the proxy
 * down and clears `state.proxy`), waits for the entry to clear, then escalates
 * to SIGKILL — clearing `state.proxy` manually in that case since SIGKILL skips
 * the clean-shutdown path. Throws `ProxyNotRunningError` if no live proxy.
 */
export async function runProxyStop(): Promise<void> {
  const { pid } = await requireRunningProxy();
  await signalProxyStop();

  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
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

/** Common options for the log-viewing commands. */
export interface ProxyLogOptions {
  /** Number of trailing lines to show. */
  lines?: number;
}

/** Default number of trailing log lines for `log` / `tail`. */
const DEFAULT_LOG_LINES = 100;

/**
 * Stream the proxy log to the terminal via `tail`. When `follow` is set the
 * process stays attached until Ctrl-C; otherwise it prints the tail and exits.
 * Prints a hint instead of erroring when no log exists yet.
 */
async function streamLog(follow: boolean, lines: number): Promise<void> {
  const logPath = proxyLogPath();
  try {
    await fs.access(logPath);
  } catch {
    logger.info(
      'no proxy log yet — start the proxy with: aurica-sandbox proxy start',
    );
    return;
  }
  const args = ['-n', String(lines), ...(follow ? ['-f'] : []), logPath];
  // `tail` is present on macOS/Linux (the only hosts this CLI targets). Inherit
  // stdio so output streams live and an inherited SIGINT terminates `-f`.
  await execa('tail', args, { stdio: 'inherit' });
}

/** Print the tail of the proxy log and exit. */
export async function runProxyLog(
  options: ProxyLogOptions = {},
): Promise<void> {
  await streamLog(false, options.lines ?? DEFAULT_LOG_LINES);
}

/** Follow the proxy log live until interrupted. */
export async function runProxyTail(
  options: ProxyLogOptions = {},
): Promise<void> {
  await streamLog(true, options.lines ?? DEFAULT_LOG_LINES);
}
