import { stateFilePath } from '#src/config/paths.js';
import { readState, withState } from '#src/state/index.js';
import type { SandboxEntry, State } from '#src/state/index.js';
import type { SandboxVM, SandboxVMProvider } from '#src/vm/types.js';

/**
 * A single registry correction produced by {@link reconcileRegistry}.
 *
 * - `started`: the VM is running on the provider but the registry had it
 *   `stopped`; `ip` carries the freshly-fetched address (or `null` if the
 *   provider hasn't allocated one yet).
 * - `stopped`: the VM is stopped on the provider but the registry had it
 *   `running`; its `ip` is cleared.
 * - `vanished`: the VM no longer exists on the provider; its entry is removed.
 * - `ip-changed`: the VM is still running but the provider reports a different
 *   IP than the registry held; `ip` carries the new address.
 */
export interface ReconcileChange {
  name: string;
  kind: 'started' | 'stopped' | 'vanished' | 'ip-changed';
  ip?: string | null;
}

/** The provider surface {@link reconcileRegistry} depends on. */
export type ReconcileProvider = Pick<SandboxVMProvider, 'listVMs' | 'infoVM'>;

/** Inputs to {@link reconcileRegistry}. */
export interface ReconcileDeps {
  provider: ReconcileProvider;
  /** Defaults to {@link stateFilePath}; injectable for tests. */
  stateFilePath?: string;
}

/** Outcome of one reconcile pass. */
export interface ReconcileResult {
  /** Whether any registry entry was mutated. */
  changed: boolean;
  /** The corrections applied, for logging. */
  changes: ReconcileChange[];
  /**
   * The latest registry state. After a commit this is the post-commit state;
   * with no changes it is the state as read. Callers reuse it to re-apply proxy
   * registrations and publish to sidecars without re-reading.
   */
  state: State;
}

/** Registry statuses that are safe to reconcile (not mid-flight under a command). */
function isTerminal(
  status: SandboxEntry['status'],
): status is 'running' | 'stopped' {
  return status === 'running' || status === 'stopped';
}

/**
 * Reconcile the on-disk sandbox registry against the provider's actual VM
 * states. Corrects terminal divergences (`running` ↔ `stopped`), refreshes
 * drifted IPs, and removes entries for VMs that no longer exist.
 *
 * Only entries already in the registry are touched (never adds builtin or
 * foreign VMs the provider also lists), and only entries in a terminal status
 * are considered — entries mid-transition under a CLI command's lock are left
 * alone. All provider calls happen outside the state-file lock; the commit
 * re-validates each entry's status inside the lock to drop changes that raced a
 * concurrent command.
 */
export async function reconcileRegistry(
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const filePath = deps.stateFilePath ?? stateFilePath();

  // 1. Snapshot the provider's VMs by name → state (no lock).
  const vms = await deps.provider.listVMs();
  const providerState = new Map<string, SandboxVM['state']>();
  for (const vm of vms) providerState.set(vm.name, vm.state);

  // 2. Read the registry and plan changes (no lock).
  const snapshot = await readState(filePath);
  const planned: ReconcileChange[] = [];
  const ipCheck: string[] = []; // running entries needing an info fetch for drift
  for (const entry of Object.values(snapshot.sandboxes)) {
    if (!isTerminal(entry.status)) continue;
    if (!providerState.has(entry.name)) {
      planned.push({ name: entry.name, kind: 'vanished' });
      continue;
    }
    const actual = providerState.get(entry.name);
    if (entry.status === 'stopped' && actual === 'running') {
      planned.push({ name: entry.name, kind: 'started' });
    } else if (entry.status === 'running' && actual === 'stopped') {
      planned.push({ name: entry.name, kind: 'stopped', ip: null });
    } else if (entry.status === 'running' && actual === 'running') {
      ipCheck.push(entry.name);
    }
    // Any other combination (e.g. provider transient) is not a terminal
    // divergence — leave it for a later pass.
  }

  if (planned.length === 0 && ipCheck.length === 0) {
    return { changed: false, changes: [], state: snapshot };
  }

  // 3. Fetch fresh IPs (no lock) for started VMs and for drift detection on
  //    steady-running VMs. A single info failure drops only that VM's check.
  const ipByName = new Map<string, string | null>();
  const namesNeedingIp = [
    ...planned.filter((c) => c.kind === 'started').map((c) => c.name),
    ...ipCheck,
  ];
  // Fetched in parallel: the on-demand heal path runs inside a bounded timeout,
  // and a serial loop over every running VM's `info` would blow that budget and
  // 403 the request that triggered the reconcile.
  await Promise.all(
    namesNeedingIp.map(async (name) => {
      try {
        const info = await deps.provider.infoVM(name);
        ipByName.set(name, info.networkInfo?.ipV4 ?? null);
      } catch {
        // Leave unset; `started` commits ip: null (pending), drift check skipped.
      }
    }),
  );

  for (const change of planned) {
    if (change.kind === 'started')
      change.ip = ipByName.get(change.name) ?? null;
  }

  // Steady-running VMs whose IP changed. Only when a non-null fresh IP differs
  // from the stored one — never clobber a good IP with a null from a hiccup.
  for (const name of ipCheck) {
    const fresh = ipByName.get(name);
    if (typeof fresh !== 'string') continue;
    if (snapshot.sandboxes[name]?.ip !== fresh) {
      planned.push({ name, kind: 'ip-changed', ip: fresh });
    }
  }

  if (planned.length === 0) {
    return { changed: false, changes: [], state: snapshot };
  }

  // 4. Commit under a short lock, re-validating each entry's status inside the
  //    mutator to drop changes that raced a concurrent command.
  const applied: ReconcileChange[] = [];
  const { state } = await withState((s) => {
    for (const change of planned) {
      const entry = s.sandboxes[change.name];
      if (!entry) continue;
      // Re-validate each change against the status it was planned for. A CLI
      // command may have moved the entry in the read→commit window; applying a
      // change whose precondition no longer holds would write stale data (e.g.
      // an IP onto a now-stopped entry) that nothing later clears.
      switch (change.kind) {
        case 'vanished': {
          if (!isTerminal(entry.status)) continue;
          Reflect.deleteProperty(s.sandboxes, change.name);
          break;
        }
        case 'started': {
          if (entry.status !== 'stopped') continue;
          entry.status = 'running';
          entry.ip = change.ip ?? null;
          break;
        }
        case 'stopped': {
          if (entry.status !== 'running') continue;
          entry.status = 'stopped';
          entry.ip = null;
          break;
        }
        case 'ip-changed': {
          if (entry.status !== 'running') continue;
          entry.ip = change.ip ?? null;
          break;
        }
      }
      applied.push(change);
    }
  }, filePath);

  return { changed: applied.length > 0, changes: applied, state };
}

/**
 * Render a one-line summary of reconcile changes for the proxy log. Returns
 * `null` when nothing changed so callers can skip logging.
 */
export function formatReconcileSummary(
  changes: readonly ReconcileChange[],
): string | null {
  if (changes.length === 0) return null;
  const parts = changes.map((c) => {
    switch (c.kind) {
      case 'started': {
        return `${c.name} stopped→running (${c.ip ?? 'pending'})`;
      }
      case 'stopped': {
        return `${c.name} running→stopped`;
      }
      case 'vanished': {
        return `${c.name} vanished (removed)`;
      }
      case 'ip-changed': {
        return `${c.name} ip→${c.ip ?? 'pending'}`;
      }
    }
  });
  return `reconciled: ${parts.join(', ')}`;
}
