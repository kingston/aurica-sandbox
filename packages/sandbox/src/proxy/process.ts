import { CredentialCache } from '#src/credentials/index.js';
import { logger } from '#src/logger.js';
import { readState, withState } from '#src/state/index.js';
import type { State } from '#src/state/index.js';

import { HostProxy } from './host-proxy.js';

export interface ProxyProcessHandle {
  host: string;
  port: number;
  stop: () => Promise<void>;
}

interface ProxyLog {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

interface ProxyProcessOptions {
  log?: ProxyLog;
}

/**
 * Boot the long-running proxy process. Claims `state.proxy` (rejecting if
 * another live proxy already holds it), seeds registrations from
 * `state.sandboxes`, and installs SIGHUP / SIGINT / SIGTERM handlers.
 *
 * Returns a handle whose `stop()` clears `state.proxy` and tears the proxy
 * down. The signal handlers also call `stop()` and `process.exit(0)`.
 */
export async function runProxyProcess(
  options: ProxyProcessOptions = {},
): Promise<ProxyProcessHandle> {
  const log: ProxyLog = options.log ?? {
    info: (m) => {
      logger.info(m);
    },
    error: (m) => {
      logger.error(m);
    },
  };

  const existing = await readState();
  if (existing.proxy && isPidAlive(existing.proxy.pid)) {
    throw new Error(
      `aurica-sandbox proxy already running (pid ${existing.proxy.pid}); refusing to start a second one`,
    );
  }

  const credentialCache = new CredentialCache({ idleTimeoutSeconds: 900 });
  const proxy = await HostProxy.create({ resolver: credentialCache });
  const addr = await proxy.listen();

  await withState((state) => {
    state.proxy = {
      pid: process.pid,
      host: addr.host,
      port: addr.port,
      startedAt: new Date().toISOString(),
    };
  });

  await applyRegistrations(proxy, await readState());

  // Visibility: mockttp emits structured events for every request lifecycle.
  const events = proxy.events();
  await events.on('request', (req) => {
    log.info(`-> ${req.method} ${req.url}`);
  });
  await events.on('abort', (req) => {
    log.error(`aborted ${req.method} ${req.url}`);
  });
  await events.on('tls-client-error', (err) => {
    log.error(
      `tls error ${err.failureCause}: ${err.tlsMetadata.sniHostname ?? '?'}`,
    );
  });

  log.info(`proxy http://${addr.host}:${addr.port} (pid ${process.pid})`);

  const onHup = (): void => {
    void (async () => {
      const fresh = await readState();
      await applyRegistrations(proxy, fresh);
      log.info(
        `proxy reloaded: ${proxy.allDomains().join(', ') || '(no domains)'}`,
      );
    })();
  };
  process.on('SIGHUP', onHup);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.off('SIGHUP', onHup);
    await proxy.close();
    await withState((state) => {
      if (state.proxy?.pid === process.pid) state.proxy = null;
    });
  };

  const onTerm = (): void => {
    stop()
      // oxlint-disable-next-line no-process-exit -- signal handler must terminate the process
      .then(() => process.exit(0))
      // oxlint-disable-next-line no-process-exit -- signal handler must terminate the process
      .catch(() => process.exit(1));
  };
  process.once('SIGINT', onTerm);
  process.once('SIGTERM', onTerm);

  return { host: addr.host, port: addr.port, stop };
}

async function applyRegistrations(
  proxy: HostProxy,
  state: State,
): Promise<void> {
  const wanted = new Set(Object.keys(state.sandboxes));
  for (const name of proxy.registeredNames()) {
    if (!wanted.has(name)) proxy.unregister(name);
  }
  for (const [name, entry] of Object.entries(state.sandboxes)) {
    proxy.register(name, {
      sourceIp: entry.ip,
      domains: entry.domains,
      actions: entry.actions,
    });
  }
  await proxy.refresh();
}

/**
 * Checks whether a process with the given PID is alive.
 *
 * We use `process.kill(pid, 0)` because, on POSIX platforms,
 * sending signal 0 doesn't actually terminate the process but acts as a way to
 * check if the process exists and if the current user has permission to signal it.
 * If the process doesn't exist, an error is thrown (code 'ESRCH');
 * if it exists but we lack permission, 'EPERM' is thrown (still means "alive").
 * Returns true if the process is running or inaccessible (from our perspective).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
