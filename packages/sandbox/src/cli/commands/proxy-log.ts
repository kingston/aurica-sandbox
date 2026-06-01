import fs from 'node:fs/promises';

import { execa } from 'execa';

import { proxyLogPath } from '#src/config/index.js';
import { logger } from '#src/logger.js';

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
