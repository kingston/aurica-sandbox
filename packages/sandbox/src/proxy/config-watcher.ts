import { type FSWatcher, watch } from 'chokidar';

/** Reasons the watcher invokes its callback. */
export type SandboxConfigEvent = 'change' | 'unlink';

/**
 * Callback fired when a watched sandbox.json changes (or, for `unlink`, is
 * deleted). `name` is the sandbox key supplied to {@link SandboxConfigWatcher.watch}.
 */
export type SandboxConfigListener = (
  event: SandboxConfigEvent,
  name: string,
  path: string,
) => void;

/**
 * Watches one `.aurica/sandbox.json` file per registered sandbox and invokes
 * a single listener for `change` / `unlink` events keyed by sandbox name.
 *
 * One chokidar watcher per file (rather than a shared multi-path instance)
 * so add/remove can be done in O(1) without juggling chokidar's internal
 * `add`/`unwatch` semantics. The total number of watched files equals the
 * number of live sandboxes — single-digit in practice.
 */
export class SandboxConfigWatcher {
  private readonly entries = new Map<
    string,
    { path: string; watcher: FSWatcher }
  >();
  private listener: SandboxConfigListener | null = null;

  /**
   * Register the single listener that handles every event. Replaces any
   * previously-registered listener.
   */
  setListener(listener: SandboxConfigListener): void {
    this.listener = listener;
  }

  /**
   * Begin watching `configPath` for `name`. If `name` is already watched at
   * a different path, the previous watcher is closed first. No-op if `name`
   * is already watching the same path.
   */
  watch(name: string, configPath: string): void {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.path === configPath) return;
      void existing.watcher.close();
    }
    const watcher = watch(configPath, {
      // Editors typically write via rename-then-replace; wait for the file to
      // settle so we don't fire on the half-written intermediate state.
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      // We only care about this single file; no need to recurse.
      depth: 0,
      // Don't fire `add` for the existing file at startup — we already have
      // the rules loaded.
      ignoreInitial: true,
    });
    watcher.on('change', () => {
      this.fire('change', name, configPath);
    });
    watcher.on('add', () => {
      // File reappeared after deletion (e.g. branch switch). Treat as a
      // change so the proxy reloads.
      this.fire('change', name, configPath);
    });
    watcher.on('unlink', () => {
      this.fire('unlink', name, configPath);
    });
    this.entries.set(name, { path: configPath, watcher });
  }

  /** Stop watching `name`. No-op if not watched. */
  unwatch(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    void entry.watcher.close();
    this.entries.delete(name);
  }

  /** Close every watcher. Call during proxy shutdown. */
  async closeAll(): Promise<void> {
    const closes = [...this.entries.values()].map((e) => e.watcher.close());
    this.entries.clear();
    await Promise.all(closes);
  }

  /** Names currently being watched. */
  watchedNames(): string[] {
    return [...this.entries.keys()];
  }

  private fire(event: SandboxConfigEvent, name: string, path: string): void {
    this.listener?.(event, name, path);
  }
}
