import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { execa } from 'execa';

import { loadSandboxConfig, stateDir } from '#src/config/index.js';
import { logger } from '#src/logger.js';
import { resolvedProxyPort } from '#src/proxy/index.js';
import { isPidAlive, readState } from '#src/state/index.js';
import { errorMessage } from '#src/utils/error-message.js';
import { pathExists } from '#src/utils/path-exists.js';
import { defaultProvider, type ProviderHealth } from '#src/vm/index.js';
import { isPlatformSupported } from '#src/vm/platform.js';

/** Outcome of a single {@link Check}: ok, non-blocking warning, or blocker. */
export type CheckStatus = 'pass' | 'warn' | 'fail';

/** Result of one prerequisite check rendered by {@link runDoctor}. */
export interface Check {
  /** Short label, e.g. `"Proxy"` or the provider's display name. */
  name: string;
  /** Whether the check passed, warned, or failed. */
  status: CheckStatus;
  /** One-line resolved fact, e.g. a version or port. */
  detail?: string;
  /** Remediation shown beneath the line on `warn`/`fail`. */
  hint?: string;
}

/** Map a status to the glyph shown at the start of its line. */
function glyph(status: CheckStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '!';
  return '✗';
}

/** Exit code for a set of checks: `1` if any hard `fail`, else `0`. */
export function summaryExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

/**
 * Map a provider's neutral {@link ProviderHealth} onto a {@link Check}. The
 * label and remediation come from the provider, so this stays free of any
 * backend-specific naming.
 */
export function providerHealthToCheck(
  displayName: string,
  health: ProviderHealth,
): Check {
  if (health.status === 'ok') {
    return {
      name: displayName,
      status: 'pass',
      detail: health.detail ?? 'installed, running',
    };
  }
  const check: Check = {
    name: displayName,
    status: 'fail',
    detail: health.detail ?? health.status.replace('-', ' '),
  };
  if (health.hint) check.hint = health.hint;
  return check;
}

/** True if `port` on loopback already has something listening. */
async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** The host platform must be one the active provider supports. */
function checkPlatform(): Check {
  if (isPlatformSupported()) {
    return { name: 'Platform', status: 'pass', detail: process.platform };
  }
  return {
    name: 'Platform',
    status: 'fail',
    detail: process.platform,
    hint: `${defaultProvider.displayName} and @aurica/sandbox require macOS.`,
  };
}

/** The active provider's backend must be installed and reachable. */
async function checkProvider(): Promise<Check> {
  const health = await defaultProvider.checkHealth();
  return providerHealthToCheck(defaultProvider.displayName, health);
}

/** Whether a tracked proxy daemon is live. */
async function checkProxy(): Promise<Check> {
  const state = await readState();
  if (state.proxy && isPidAlive(state.proxy.pid)) {
    return {
      name: 'Proxy',
      status: 'pass',
      detail: `pid ${state.proxy.pid} http://${state.proxy.host}:${state.proxy.port}`,
    };
  }
  return {
    name: 'Proxy',
    status: 'warn',
    detail: 'not running',
    hint: 'Commands autostart it, or run `asbox proxy start`.',
  };
}

/**
 * The proxy port should be free when no tracked proxy owns it. A live tracked
 * proxy legitimately binds it — that's covered by {@link checkProxy} — so this
 * only flags an untracked occupant.
 */
async function checkProxyPort(): Promise<Check> {
  const port = resolvedProxyPort();
  const state = await readState();
  if (state.proxy && isPidAlive(state.proxy.pid)) {
    return {
      name: 'Proxy port',
      status: 'pass',
      detail: `${port} (in use by proxy)`,
    };
  }
  if (await portInUse(port)) {
    return {
      name: 'Proxy port',
      status: 'warn',
      detail: `${port} in use`,
      hint: `Port ${port} is in use but no tracked proxy owns it. Free it or set AURICA_PROXY_PORT to an open port.`,
    };
  }
  return { name: 'Proxy port', status: 'pass', detail: `${port} free` };
}

/** The proxy CA should exist (it's generated on first proxy start). */
async function checkCA(): Promise<Check> {
  const caDir = path.join(stateDir(), 'ca');
  const haveKey = await pathExists(path.join(caDir, 'key.pem'));
  const haveCert = await pathExists(path.join(caDir, 'cert.pem'));
  if (haveKey && haveCert) {
    return { name: 'Proxy CA', status: 'pass', detail: caDir };
  }
  return {
    name: 'Proxy CA',
    status: 'warn',
    detail: 'not generated yet',
    hint: 'Generated automatically when the proxy first starts; no action needed.',
  };
}

/** The project must have a present, valid `.aurica/sandbox.json`. */
async function checkProjectConfig(projectDir: string): Promise<Check> {
  try {
    const config = await loadSandboxConfig(projectDir);
    return { name: 'Project config', status: 'pass', detail: config.name };
  } catch (err) {
    const msg = errorMessage(err);
    const missing = /ENOENT|no such file/i.test(msg);
    return {
      name: 'Project config',
      status: 'fail',
      detail: missing ? 'missing' : 'invalid',
      hint: missing ? 'No .aurica/sandbox.json; run `asbox init`.' : msg,
    };
  }
}

/**
 * GitHub CLI availability — only relevant if the project uses `gh-token`
 * credential sources, so a miss warns rather than fails.
 */
async function checkGhCli(): Promise<Check> {
  try {
    await execa('gh', ['auth', 'status']);
    return { name: 'GitHub CLI', status: 'pass', detail: 'authenticated' };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      name: 'GitHub CLI',
      status: 'warn',
      detail: missing ? 'not installed' : 'not authenticated',
      hint: 'Install gh (https://cli.github.com) and run `gh auth login` if you use gh-token credential sources.',
    };
  }
}

/**
 * Run prerequisite checks for creating sandboxes and print a report. Returns
 * `1` if any check is a hard `fail`, else `0`.
 *
 * Side-effect-free: it never autostarts the proxy, resolves credentials, or
 * generates the CA — it only observes. It runs on every platform so it can
 * report a non-macOS host as a failed check rather than crashing.
 */
export async function runDoctor(projectDir: string): Promise<number> {
  const checks: Check[] = [
    checkPlatform(),
    await checkProvider(),
    await checkProxy(),
    await checkProxyPort(),
    await checkCA(),
    await checkProjectConfig(projectDir),
    await checkGhCli(),
  ];

  for (const check of checks) {
    const detail = check.detail ? ` — ${check.detail}` : '';
    // Use a single leading glyph for the status so lines align; consola's
    // own leveled prefixes would add a second, conflicting symbol.
    logger.log(`${glyph(check.status)} ${check.name}${detail}`);
    if (check.hint && check.status !== 'pass') logger.log(`    ${check.hint}`);
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const code = summaryExitCode(checks);
  if (code !== 0) {
    logger.error(
      `${failed} check(s) failed; resolve them before \`asbox create\`.`,
    );
  } else if (warned > 0) {
    logger.info(`${warned} warning(s); you can still \`asbox create\`.`);
  } else {
    logger.success('all checks passed.');
  }
  return code;
}
