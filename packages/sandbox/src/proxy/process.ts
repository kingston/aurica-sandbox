import {
  loadSandboxConfig,
  loadUserConfig,
  sandboxConfigPath,
} from '#src/config/index.js';
import { CredentialCache } from '#src/credentials/index.js';
import { logger } from '#src/logger.js';
import { PLUGINS } from '#src/plugins/index.js';
import type {
  ProxySidecar,
  SandboxRegistrationStream,
} from '#src/plugins/index.js';
import { readState, withState } from '#src/state/index.js';
import type { SandboxEntry, State } from '#src/state/index.js';
import { errorMessage } from '#src/utils/error-message.js';

import { SandboxConfigWatcher } from './config-watcher.js';
import { deriveRulesFromConfig } from './derive-rules.js';
import {
  HostProxy,
  normalizeRemoteIp,
  type VerboseDenialLog,
  type VerboseRequestLog,
} from './host-proxy.js';

/**
 * Default port for the singleton host proxy. Pinned (rather than ephemeral) so
 * that VMs created against an earlier proxy run still reach the proxy after a
 * restart — their iptables rules and `/etc/environment` bake in the port at
 * creation time and aren't rewritten when the proxy comes back up.
 *
 * Chosen from the IANA dynamic/private range (49152–65535) to avoid colliding
 * with well-known services. If this port is busy, `mockttp.start()` will
 * reject and `runProxyProcess` surfaces the error — that's the desired
 * behavior; we don't want to silently land on a different port.
 *
 * Override via `AURICA_PROXY_PORT` to run a second instance (e.g. a dev build
 * alongside a live install) on a different port. Combine with `AURICA_HOME`
 * to isolate state, certs, and the proxy registry. The port is baked into a
 * VM's iptables / `/etc/environment` at create time, so changing
 * `AURICA_PROXY_PORT` after VMs exist will leave those VMs unable to reach
 * the proxy until they're rebuilt.
 */
const DEFAULT_PROXY_PORT = 51_217;

function resolveProxyPort(log: ProxyLog): number {
  const raw = process.env.AURICA_PROXY_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PROXY_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    log.error(
      `AURICA_PROXY_PORT=${raw} is not a valid port (1–65535); using default ${DEFAULT_PROXY_PORT}`,
    );
    return DEFAULT_PROXY_PORT;
  }
  return parsed;
}

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
  /**
   * When true, log a verbose decision line for every request — matched
   * policy id, outcome (pass/block/rewrite), and any applied mutations
   * (values redacted) — and surface allowlist denials with method+host+IP.
   * Defaults to false; the proxy still logs one line per response either
   * way.
   */
  verbose?: boolean;
}

/**
 * Boot the long-running proxy process. Claims `state.proxy` (rejecting if
 * another live proxy already holds it), seeds registrations from
 * `state.sandboxes` (loading rules directly from each sandbox's
 * `.aurica/sandbox.json`), and installs SIGHUP / SIGINT / SIGTERM handlers.
 *
 * Also starts a chokidar watcher per registered sandbox.json — edits to the
 * file are picked up automatically without needing a SIGHUP. SIGHUP itself
 * is still used for register/unregister events (a new sandbox appears or an
 * existing one is destroyed).
 *
 * Returns a handle whose `stop()` closes the watchers, clears `state.proxy`,
 * and tears the proxy down. The signal handlers also call `stop()` and
 * `process.exit(0)`.
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
  const verbose = options.verbose === true;
  const proxyOptions: Parameters<typeof HostProxy.create>[0] = {
    resolver: credentialCache,
    port: resolveProxyPort(log),
  };
  if (verbose) {
    proxyOptions.verboseLogger = (event) => {
      logVerbose(log, event);
    };
  }
  const proxy = await HostProxy.create(proxyOptions);
  const addr = await proxy.listen();

  const watcher = new SandboxConfigWatcher();
  const linuxUser = process.env.USER ?? 'sandbox';

  // In-process pub/sub for sandbox registration changes. Sidecars
  // subscribe to this so they can keep per-sandbox tables in sync as
  // sandboxes are created, destroyed, or have their `sandbox.json`
  // edited. The stream fires once on subscribe with the current
  // snapshot, then on every subsequent change.
  const stream = new InMemorySandboxRegistrationStream();
  const publishStreamSnapshot = async (): Promise<void> => {
    const state = await readState();
    stream.publish(Object.values(state.sandboxes));
  };

  watcher.setListener((event, name, path) => {
    if (event === 'unlink') {
      log.error(
        `sandbox.json removed for ${name} (${path}); keeping last-good rules in effect`,
      );
      return;
    }
    void (async () => {
      const state = await readState();
      const entry = state.sandboxes[name];
      if (!entry) return;
      const ok = await loadAndRegister(proxy, watcher, entry, linuxUser, log);
      if (ok) {
        await proxy.refresh();
        log.info(`proxy reloaded for ${name} from ${path}`);
      }
      // A sandbox.json edit can change plugin opt-ins, so re-publish
      // even when the host proxy's registration set didn't move —
      // sidecars subscribe to this stream to refresh their per-sandbox
      // derived state.
      stream.publish(Object.values(state.sandboxes));
    })();
  });

  await publishStreamSnapshot();

  // Visibility: mockttp emits structured events for every request lifecycle.
  // Registered via setEventSubscriber so the listeners get re-attached after
  // every rule rebuild — mockttp's reset() drops both rules and listeners.
  //
  // We log on response (not request) so each line carries the outcome — the
  // status code makes success vs. failure obvious at a glance. Method + URL
  // and the originating IP aren't on the response event, so we track them
  // by request id and consume the entry on response/abort.
  const inflight = new Map<string, { label: string; remoteIp: string }>();
  await proxy.setEventSubscriber(async (server) => {
    await server.on('request', (req) => {
      inflight.set(req.id, {
        label: `${req.method} ${req.url}`,
        remoteIp: normalizeRemoteIp(req.remoteIpAddress) ?? '?',
      });
    });
    await server.on('response', (res) => {
      const entry = inflight.get(res.id);
      inflight.delete(res.id);
      const label = entry?.label ?? `? ${res.id}`;
      const remoteIp = entry?.remoteIp ?? '?';
      const line = `${res.statusCode} [${remoteIp}] ${label}`;
      if (res.statusCode >= 400) log.error(line.trimEnd());
      else log.info(line.trimEnd());
    });
    await server.on('abort', (req) => {
      const entry = inflight.get(req.id);
      inflight.delete(req.id);
      const remoteIp = entry?.remoteIp ?? '?';
      log.error(`aborted [${remoteIp}] ${req.method} ${req.url}`);
    });
    await server.on('tls-client-error', (err) => {
      log.error(
        `tls error ${err.failureCause}: ${err.tlsMetadata.sniHostname ?? '?'}`,
      );
    });
  });

  // Commit the proxy entry to disk so `requireRunningProxy` succeeds
  // for any subsequent CLI call (e.g. `create`).
  await withState((state) => {
    state.proxy = {
      pid: process.pid,
      host: addr.host,
      port: addr.port,
      startedAt: new Date().toISOString(),
    };
  });

  // Start any plugin-contributed sidecars. Each plugin's hook is called
  // once at boot; the returned handle is retained so we can await its
  // `stop()` on shutdown. Sidecars that throw at boot fail the whole
  // proxy startup — partial readiness would hide real configuration
  // errors behind subtle later-stage failures.
  //
  // Loaders are injected (rather than imported by the plugin) to keep
  // plugin modules out of the registry-init cycle that runs through
  // `config/user.ts` ↔ `userPluginsSchema`. The proxy entry point lives
  // outside that cycle, so it can value-import these freely.
  const sidecars: ProxySidecar[] = [];
  for (const plugin of PLUGINS) {
    if (!plugin.proxySidecar) continue;
    const sidecar = await plugin.proxySidecar({
      loadUserConfig,
      loadSandboxConfig,
      sandboxes: stream,
      credentialResolver: credentialCache,
    });
    if (sidecar) sidecars.push(sidecar);
  }

  // Register sandboxes now that the proxy entry is on disk. Plugins like
  // `mcp` read this state to derive their domains, policies, and
  // post-lockdown commands.
  await applyRegistrations(proxy, watcher, await readState(), linuxUser, log);

  log.info(`proxy http://${addr.host}:${addr.port} (pid ${process.pid})`);

  const onHup = (): void => {
    void (async () => {
      const fresh = await readState();
      await applyRegistrations(proxy, watcher, fresh, linuxUser, log);
      log.info(formatReloadSummary(proxy.summary()));
      stream.publish(Object.values(fresh.sandboxes));
    })();
  };
  process.on('SIGHUP', onHup);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.off('SIGHUP', onHup);
    // Sidecars first so they can drain in-flight work while the proxy
    // is still up (e.g. log a structured "stopping" line, finish a
    // pending OAuth callback). Awaited in parallel; one failure
    // shouldn't block the others.
    await Promise.all(
      sidecars.map(async (sidecar) => {
        try {
          await sidecar.stop();
        } catch (err) {
          log.error(`sidecar stop failed: ${errorMessage(err)}`);
        }
      }),
    );
    await watcher.closeAll();
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

/**
 * In-memory implementation of {@link SandboxRegistrationStream}. Kept
 * private to this module — the surface area is shaped exactly by what
 * sidecars need: a `snapshot()` for synchronous reads and a `subscribe()`
 * that fires once immediately with the current snapshot and then on
 * every publish.
 *
 * Listeners are stored in an Array (rather than a Set) so insertion
 * order is preserved across publish calls, which makes the test
 * assertions for multi-sidecar setups deterministic.
 */
class InMemorySandboxRegistrationStream implements SandboxRegistrationStream {
  #current: readonly SandboxEntry[] = [];
  readonly #listeners: ((snapshot: readonly SandboxEntry[]) => void)[] = [];

  snapshot(): readonly SandboxEntry[] {
    return this.#current;
  }

  subscribe(listener: (snapshot: readonly SandboxEntry[]) => void): () => void {
    this.#listeners.push(listener);
    listener(this.#current);
    return () => {
      const idx = this.#listeners.indexOf(listener);
      if (idx !== -1) this.#listeners.splice(idx, 1);
    };
  }

  publish(entries: readonly SandboxEntry[]): void {
    this.#current = entries;
    // Iterate a snapshot of the listeners array so a subscriber that
    // unsubscribes during its callback doesn't shift indices under us.
    const snapshot = [...this.#listeners];
    for (const listener of snapshot) listener(entries);
  }
}

/**
 * Reconcile the proxy's registration set + watcher set against the current
 * `state.sandboxes`. For each newly-present sandbox: load rules from disk
 * and start watching its sandbox.json. For each removed sandbox: unregister
 * + stop watching. Always ends with `proxy.refresh()`.
 */
async function applyRegistrations(
  proxy: HostProxy,
  watcher: SandboxConfigWatcher,
  state: State,
  linuxUser: string,
  log: ProxyLog,
): Promise<void> {
  const wanted = new Set(Object.keys(state.sandboxes));
  for (const name of proxy.registeredNames()) {
    if (!wanted.has(name)) {
      proxy.unregister(name);
      watcher.unwatch(name);
    }
  }
  for (const entry of Object.values(state.sandboxes)) {
    await loadAndRegister(proxy, watcher, entry, linuxUser, log);
  }
  await proxy.refresh();
}

/**
 * Load `<projectDir>/.aurica/sandbox.json` for one sandbox, derive the
 * proxy rules, register them with the proxy, and ensure the file is being
 * watched.
 *
 * Returns `true` on success. On failure (file missing, parse error, schema
 * failure, cross-field invariant failure) logs an error and returns `false`
 * — any prior registration is left intact so transient bad saves don't
 * disrupt live traffic.
 */
async function loadAndRegister(
  proxy: HostProxy,
  watcher: SandboxConfigWatcher,
  entry: SandboxEntry,
  linuxUser: string,
  log: ProxyLog,
): Promise<boolean> {
  try {
    const config = await loadSandboxConfig(entry.projectDir);
    const { domains, policies } = deriveRulesFromConfig(config, {
      user: linuxUser,
      sandboxName: entry.name,
      authSecret: entry.authSecret,
    });
    proxy.register(entry.name, {
      sourceIp: entry.ip,
      domains,
      policies,
    });
    watcher.watch(entry.name, sandboxConfigPath(entry.projectDir));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`failed to load rules for ${entry.name}: ${msg}`);
    // Still watch the file so a corrected save triggers a retry.
    watcher.watch(entry.name, sandboxConfigPath(entry.projectDir));
    return false;
  }
}

/**
 * Render a verbose `decision` or `denial` event onto the proxy log.
 *
 * Decision lines describe what the proxy decided to do *before* the upstream
 * replies — they always pair with a matching response line, so duplicating
 * status here would be premature. The summary captures the policy that
 * matched (if any), the outcome, any URL rewrite, and a redacted view of
 * each mutation actually applied to the outgoing request.
 *
 * Denial lines fire from the unmatched-request sweep so verbose users see
 * the request that was rejected by the allowlist (without it, only the 403
 * response line shows up).
 */
function logVerbose(
  log: ProxyLog,
  event:
    | ({ type: 'decision' } & VerboseRequestLog)
    | ({ type: 'denial' } & VerboseDenialLog),
): void {
  if (event.type === 'denial') {
    log.info(
      `denied [${event.remoteIp}] ${event.method} ${event.host}${event.path} (allowlist)`,
    );
    return;
  }
  const policy = event.matchedPolicyId ?? '(no match)';
  const tail =
    event.outcome === 'block'
      ? ` blockedBy=${event.blockedBy ?? policy}`
      : event.outcome === 'rewrite' && event.rewriteUrl !== undefined
        ? ` -> ${event.rewriteUrl}`
        : '';
  log.info(
    `${event.outcome} [${event.remoteIp}] ${event.method} ${event.host}${event.path} policy=${policy}${tail}`,
  );
  for (const m of event.mutations) {
    const valuePart =
      m.kind === 'remove-header'
        ? ''
        : m.redacted === true
          ? ' = <redacted>'
          : ` = ${m.value ?? ''}`;
    log.info(`  ${m.kind} ${m.header}${valuePart}`);
  }
}

/**
 * Format a one-line-per-sandbox SIGHUP reload summary. `(pending)` stands in
 * for `sourceIp: null` (registration exists but the VM's IP hasn't been
 * allocated yet). Empty registration set logs `(no sandboxes)`.
 */
function formatReloadSummary(
  entries: { name: string; sourceIp: string | null; domains: string[] }[],
): string {
  if (entries.length === 0) return 'proxy reloaded: (no sandboxes)';
  const lines = entries.map((e) => {
    const ip = e.sourceIp ?? 'pending';
    const domains = e.domains.join(', ') || '(no domains)';
    return `  ${e.name} (${ip}): ${domains}`;
  });
  return `proxy reloaded:\n${lines.join('\n')}`;
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
