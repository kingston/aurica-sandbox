import {
  loadSandboxConfig,
  loadUserConfig,
  sandboxConfigPath,
} from '#src/config/index.js';
import { CredentialResolver } from '#src/credentials/index.js';
import { createTimestampedLogger } from '#src/logger.js';
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
  type AppliedMutation,
  HostProxy,
  normalizeRemoteIp,
  type VerboseDecisionEvent,
  type VerboseDenialLog,
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
  // The long-running proxy gets its own consola instance with a fixed
  // `[HH:MM:SS]` timestamp column (see `createTimestampedLogger`), so its
  // scattered per-request output reads as one scannable stream. Scoped here
  // rather than on the global `logger` so other CLI commands keep consola's
  // default look. Tests inject their own `log`.
  const proxyLogger = createTimestampedLogger();
  const log: ProxyLog = options.log ?? {
    info: (m) => {
      proxyLogger.info(m);
    },
    error: (m) => {
      proxyLogger.error(m);
    },
  };

  const existing = await readState();
  if (existing.proxy && isPidAlive(existing.proxy.pid)) {
    throw new Error(
      `aurica-sandbox proxy already running (pid ${existing.proxy.pid}); refusing to start a second one`,
    );
  }

  const credentialResolver = new CredentialResolver();
  const verbose = options.verbose === true;

  // Per-request log state keyed by mockttp's request id. Populated on the
  // `request` event (method/url/IP) and, in verbose mode, augmented with the
  // proxy's decision (matched policy + applied mutations) when `beforeRequest`
  // fires. The terminal event (`response` / `abort`) consumes the entry and
  // renders a single consolidated block, so a request's decision and outcome
  // appear together rather than as separate interleaved lines.
  const inflight = new Map<string, InflightRequest>();

  const proxyOptions: Parameters<typeof HostProxy.create>[0] = {
    resolver: credentialResolver,
    port: resolveProxyPort(log),
  };
  if (verbose) {
    // Buffer the decision onto the in-flight entry; the response handler folds
    // it into the completion block as policy/mutation child lines. The decision
    // (emitted from `beforeRequest`/the denial sweep) and mockttp's `request`
    // event race — either can arrive first — so create-or-merge rather than
    // require a pre-existing entry. (With the unified render path a dropped
    // decision only costs child lines, not a divergent line shape, but merging
    // maximizes when the policy/mutation detail shows up.)
    proxyOptions.verboseLogger = (event) => {
      // `mutations-append` is emitted by OAuth intercept handlers that fire
      // after the initial `decision` was buffered (refresh short-circuit in
      // `beforeRequest`; authorization_code capture in `beforeResponse`).
      // Fold the late mutations into the existing buffered decision so the
      // per-request render shows them alongside the normal `replace-header`
      // / `remove-header` rows. No `remoteIp` on these events — they're
      // updates to an already-tracked id.
      if (event.type === 'mutations-append') {
        const entry = inflight.get(event.id);
        if (
          entry?.decision !== undefined &&
          'appliedMutations' in entry.decision
        ) {
          entry.decision = {
            ...entry.decision,
            appliedMutations: [
              ...entry.decision.appliedMutations,
              ...event.mutations,
            ],
          };
        }
        return;
      }
      let entry = inflight.get(event.id);
      if (!entry) {
        const sourceName = resolveSourceName(proxy, event.remoteIp);
        entry = {
          remoteIp: event.remoteIp,
          ...(sourceName ? { sourceName } : {}),
        };
        inflight.set(event.id, entry);
      }
      entry.decision = event;
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
  // We render on the terminal event (response/abort), not on request, so each
  // log carries the outcome. In verbose mode the buffered decision is folded
  // in, producing one consolidated block per request; otherwise a single
  // status line. Method + URL and the originating IP aren't on the response
  // event, so we track them by request id and consume the entry here.
  await proxy.setEventSubscriber(async (server) => {
    await server.on('request', (req) => {
      const remoteIp = normalizeRemoteIp(req.remoteIpAddress) ?? '?';
      const sourceName = resolveSourceName(proxy, remoteIp);
      // Merge, don't overwrite: in verbose mode the decision can be buffered
      // onto this id before the `request` event arrives (the two race), so a
      // plain `set` would clobber it.
      const entry = inflight.get(req.id) ?? { remoteIp };
      entry.method = req.method;
      entry.url = req.url;
      entry.remoteIp = remoteIp;
      if (sourceName) entry.sourceName = sourceName;
      inflight.set(req.id, entry);
    });
    await server.on('response', (res) => {
      const entry = inflight.get(res.id) ?? { remoteIp: '?' };
      inflight.delete(res.id);
      const block = formatRequestBlock(entry, {
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
      });
      if (res.statusCode >= 400) log.error(block);
      else log.info(block);
    });
    await server.on('abort', (req) => {
      const entry = inflight.get(req.id) ?? { remoteIp: '?' };
      inflight.delete(req.id);
      entry.method ??= req.method;
      entry.url ??= req.url;
      log.error(formatRequestBlock(entry, 'aborted'));
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
      credentialResolver: credentialResolver,
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
    const { domains, policies, configDomains, enabledPlugins } =
      await deriveRulesFromConfig(config, {
        user: linuxUser,
        sandboxName: entry.name,
        authSecret: entry.authSecret,
      });
    proxy.register(entry.name, {
      sourceIp: entry.ip,
      domains,
      policies,
      configDomains,
      enabledPlugins,
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

/** The buffered verbose decision/denial event for one in-flight request. */
export type BufferedDecision =
  | ({ type: 'decision' } & VerboseDecisionEvent)
  | ({ type: 'denial' } & VerboseDenialLog);

/**
 * Per-request log state tracked between the `request` event and the terminal
 * (`response` / `abort`) event. `method`/`url`/`remoteIp` come from the
 * `request` event and render the parent line when no decision is buffered;
 * `sourceName` is the human-readable sandbox name resolved from the originating
 * IP (falls back to the raw IP when unknown); `decision` is set only in verbose
 * mode and adds the policy/mutation child lines. Every request renders through
 * {@link formatRequestBlock} — a decision-less entry is simply a bare parent
 * line, so verbose and non-verbose output share one shape.
 */
export interface InflightRequest {
  method?: string;
  url?: string;
  remoteIp: string;
  sourceName?: string;
  decision?: BufferedDecision;
}

/** Outcome passed to {@link formatRequestBlock}: a response, or an abort. */
export type RequestOutcome =
  | { statusCode: number; statusMessage: string }
  | 'aborted';

/**
 * Width of the reporter's `[HH:MM:SS] ` prefix. Child lines start with this many
 * spaces so their tree connector (`│` / `└─`) lands in the column directly under
 * the source-name bracket on the parent line.
 */
const TIMESTAMP_WIDTH = 11;

/** Fixed display width of the `[source]` field on the parent line. */
const SOURCE_WIDTH = 18;

/** Leading whitespace that aligns a child line's connector under the source bracket. */
const CHILD_INDENT = ' '.repeat(TIMESTAMP_WIDTH);

/**
 * Resolve a request's originating IP to the human-readable name of the sandbox
 * registered for that IP, or `undefined` when no registration matches (the
 * caller falls back to the raw IP). When several sandboxes share an IP the first
 * match wins — that's only a display nicety, not an enforcement decision.
 */
function resolveSourceName(
  proxy: HostProxy,
  remoteIp: string,
): string | undefined {
  if (remoteIp === '?') return undefined;
  return proxy.summary().find((s) => s.sourceIp === remoteIp)?.name;
}

/** Status emoji by class: 🟢 2xx, 🟡 3xx, 🔴 4xx/5xx, ⚫ aborted. */
function statusEmoji(outcome: RequestOutcome): string {
  if (outcome === 'aborted') return '⚫';
  const c = outcome.statusCode;
  if (c >= 200 && c < 300) return '🟢';
  if (c >= 300 && c < 400) return '🟡';
  return '🔴';
}

/**
 * Render the fixed-width `[source]` field for the parent line. Names longer than
 * the available room are truncated with an ellipsis; shorter ones are right-
 * padded so the emoji/status column lines up across requests.
 */
function formatSource(source: string): string {
  const inner = SOURCE_WIDTH - 2; // room between the brackets
  const name =
    source.length > inner ? `${source.slice(0, inner - 1)}…` : source;
  return `[${name}]`.padEnd(SOURCE_WIDTH);
}

/**
 * Render one consolidated verbose block for a completed request — the proxy's
 * decision (matched policy + applied mutations) and the upstream outcome
 * together, so a request's full story is one stanza rather than separate
 * interleaved lines.
 *
 * The parent line carries source, status, method, and the full URL:
 * `[source]<pad> EMOJI CODE METHOD https://host/path`. The reporter prepends the
 * `[HH:MM:SS] ` clock. Child lines (policy, mutations, denial reason) hang below
 * with tree connectors — `│` for every line but the last, `└─` for the last —
 * aligned under the source bracket. A request with no policy and no mutations
 * prints only the parent line.
 *
 * `set-header` / `replace-header` always carry a credential-sourced value (the
 * resolver only accepts `<scheme>:<name>` refs), so values render as
 * `<redacted>` rather than the resolved secret.
 */
export function formatRequestBlock(
  entry: InflightRequest,
  outcome: RequestOutcome,
): string {
  const d = entry.decision;
  const source = entry.sourceName ?? d?.remoteIp ?? entry.remoteIp;
  const method = d?.method ?? entry.method ?? '?';
  // A decision-less entry has the full request URL (scheme included) from the
  // `request` event. The decision carries host+path only; the proxy intercepts
  // HTTPS, so reconstruct the `https://` scheme to match.
  const url = d ? `https://${d.host}${d.path}` : (entry.url ?? '');

  const code = outcome === 'aborted' ? 'aborted' : String(outcome.statusCode);
  const parent = `${formatSource(source)} ${statusEmoji(outcome)} ${code} ${method} ${url}`;

  // Collect child lines first so we know which is last (└─ vs │). A plain
  // pass that matched no credential policy and applied no mutations (every
  // ordinary `git fetch` / npm / github request) has nothing to add, so it
  // renders as a bare parent line — no `policy: (no match)` noise, no empty
  // `└─`. Only a matched policy, a block, a rewrite, or mutations earn children.
  const children: string[] = [];
  if (d?.type === 'denial') {
    children.push(`denied: ${d.reason}`);
  } else if (d?.type === 'decision') {
    const policyId = d.outcome === 'block' ? d.blockedBy : d.matchedPolicyId;
    if (policyId) children.push(`policy: ${policyId}`);
    if (d.outcome === 'rewrite') children.push(`rewrite: ${d.url}`);
    appendMutations(children, d.appliedMutations);
  }

  if (children.length === 0) return parent;

  const lines = [parent];
  const last = children.length - 1;
  for (const [i, child] of children.entries()) {
    const connector = i === last ? '└─' : '│ ';
    lines.push(`${CHILD_INDENT}${connector} ${child}`);
  }
  return lines.join('\n');
}

/**
 * Append the `mutations:` header plus one `✓`/`⚠` line per mutation to `children`.
 * Nothing is appended when no mutations are configured. The per-mutation lines
 * are nested a further two columns past the `mutations:` header.
 *
 * `✓`/`⚠` are pinned to text presentation (`︎`) so they render single-width
 * in terminals that would otherwise show `⚠` as a double-width emoji, keeping the
 * mutation-kind column aligned across applied and skipped rows.
 */
function appendMutations(
  children: string[],
  mutations: readonly AppliedMutation[],
): void {
  if (mutations.length === 0) return;
  children.push('mutations:');
  const kindWidth = Math.max(...mutations.map((m) => m.kind.length));
  for (const m of mutations) {
    const mark = m.status === 'applied' ? '✓︎' : '⚠︎';
    const kind = m.kind.padEnd(kindWidth);
    // Header mutations carry a redacted-value suffix; `remove-header` and the
    // OAuth-event kinds don't substitute a value, so they show only the
    // target (the header name or recordKey) plus any skip/applied reason.
    const carriesValue = m.kind === 'set-header' || m.kind === 'replace-header';
    const valuePart =
      carriesValue && m.status === 'applied' ? ' = <redacted>' : '';
    let detail = valuePart;
    if (m.status === 'skipped') {
      detail = ` (skipped: ${m.reason ?? 'no-op'})`;
    } else if (!carriesValue && m.reason !== undefined) {
      // OAuth-applied lines surface their reason (e.g. counter bump details).
      detail = ` (${m.reason})`;
    }
    children.push(` ${mark} ${kind}  ${m.target}${detail}`);
  }
}

/**
 * Format a SIGHUP reload summary. Each sandbox shows the domains it explicitly
 * permitted (`proxy.domains`) and the names of the enabled plugins — the
 * plugin-contributed domains are summarized by plugin name rather than listed.
 * `(pending)` stands in for `sourceIp: null` (registration exists but the VM's
 * IP hasn't been allocated yet). Empty registration set logs `(no sandboxes)`.
 */
function formatReloadSummary(
  entries: {
    name: string;
    sourceIp: string | null;
    configDomains: string[];
    enabledPlugins: string[];
  }[],
): string {
  if (entries.length === 0) return 'proxy reloaded: (no sandboxes)';
  const lines = entries.map((e) => {
    const ip = e.sourceIp ?? 'pending';
    const domains = e.configDomains.join(', ') || '(none)';
    const plugins = e.enabledPlugins.join(', ') || '(no plugins)';
    return `  ${e.name} (${ip})\n    domains: ${domains}\n    plugins: ${plugins}`;
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
