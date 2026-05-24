export interface SandboxVM {
  name: string;
  networkInfo?: {
    ipV4: string;
    ipV6?: string;
  };
}

/**
 * Provider-agnostic exec channel into a single sandbox VM. The orchestrator
 * uses `pushDir` to stage scripts and `run` to invoke them; both must stream
 * child stdio to the host terminal so the user sees live progress.
 *
 * Implementations must reject the returned promise on a non-zero exit code.
 */
export interface VMExec {
  /**
   * Push the contents of `localDir` into the VM at `dest`. Recursive. The
   * destination directory is created if absent. `dest` is either a path
   * relative to the default user's home (e.g. `code/repo`) or an absolute
   * path (must start with `/`, e.g. `/workspaces/repo`). Files are written
   * as the default user via tar-over-stdin, so the destination must be
   * writable by them.
   */
  pushDir(localDir: string, dest: string): Promise<void>;

  /**
   * Push a single host file to `vmAbsPath` inside the VM. The path must be
   * absolute (start with `/`). Parent directories are created if missing.
   * File mode and mtime are preserved (single-file tar-over-stdin). The
   * destination must be writable by the default user.
   */
  pushFile(localFile: string, vmAbsPath: string): Promise<void>;

  /**
   * Run a command inside the VM. `user: 'root'` switches to root; `'default'`
   * uses the VM's default Linux user. When `cwd` is set, the command runs
   * with that path as its working directory — callers should rely on this
   * rather than wrapping `argv` in `bash -c 'cd …'`. When `env` is set, each
   * key/value is injected into the command's environment — callers should
   * rely on this rather than prefixing `argv` with `K=V` shell assignments,
   * which would require an unsafe `bash -c` wrapper.
   */
  run(args: {
    user: 'root' | 'default';
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<void>;
}

export interface CreateVMOptions {
  name: string;
  distro?: 'ubuntu' | 'debian';
  arch?: 'amd64' | 'arm64';
  /**
   * Pre-formatted host->VM bind-mount arguments in `SOURCE[:DEST]` form,
   * passed straight to the provider's create command (e.g. `orbctl create
   * --mount`). Callers are responsible for resolving sources to absolute
   * host paths before constructing these strings.
   */
  mounts?: string[];
}

/**
 * Address VMs use to reach services on the host. For OrbStack this is the
 * host's IPv4 on `bridge100`; for Lima it would typically be the gateway on
 * `lima0`. The `source` field is opaque to the proxy layer — providers use
 * it to communicate how confident they are in the value (e.g. operator
 * override vs. heuristic) so callers can log accordingly.
 */
export interface HostBridgeIp {
  ip: string;
  source: string;
}

export interface SandboxVMProvider {
  createVM: (options: CreateVMOptions) => Promise<SandboxVM>;
  /**
   * Clone an existing stopped VM into a new VM with the given name. The
   * source VM is paused briefly during the clone operation and resumes its
   * prior state (stopped) when done. The new VM starts in the stopped state;
   * callers must `startVM` it separately. Disk is copy-on-write — no
   * double usage until the fork diverges.
   */
  cloneVM: (sourceName: string, destName: string) => Promise<SandboxVM>;
  destroyVM: (name: string) => Promise<void>;
  startVM: (name: string) => Promise<SandboxVM>;
  stopVM: (name: string) => Promise<void>;
  infoVM: (name: string) => Promise<SandboxVM>;
  listVMs: () => Promise<SandboxVM[]>;
  /**
   * Resolve the address VMs should connect to in order to reach the host
   * proxy. Providers must return an address whose connections preserve the
   * VM's source IP (so per-sandbox allowlisting works) — for OrbStack this
   * means the host's bridge IP, **not** the magic `host.orb.internal`
   * hostname that NATs to `127.0.0.1`.
   *
   * Called once at proxy startup. May throw on a fresh install if the
   * provider has no signal to derive the address from; users can set a
   * provider-specific env override (e.g. `AURICA_PROXY_BIND_IP` for orb)
   * to bootstrap.
   */
  discoverHostBridgeIp: () => Promise<HostBridgeIp>;
  /**
   * Build a {@link VMExec} for a single VM. Used by the init pipeline to
   * stage scripts (`pushDir`) and run commands (`run`) inside the VM. The
   * returned exec is provider-specific (orb shells out to `orbctl run`),
   * but the surface is provider-agnostic so command code stays generic.
   */
  createExec: (name: string, defaultUser: string) => VMExec;
  /**
   * Provider-specific shell snippet injected into the VM init script as
   * step 2 (after base apt packages, before plugin bootstrap, before the
   * iptables lockdown). Used for quirks that don't belong in the
   * cross-provider init — e.g. OrbStack removes its passwordless-sudo
   * grant here. Empty string when the provider has nothing to contribute.
   *
   * Bash, runs as root with the network still open. Must not rely on
   * `${user}` interpolation — if a snippet needs the default user name,
   * the provider should bake it in at construction time or expose its own
   * factory.
   */
  bootstrapScript: string;
  /**
   * Run a one-shot user-supplied command inside `name` with `env` injected
   * and stdio inherited from the parent process. Returns the child's exit
   * code (or `1` if the provider can't surface one). Used by
   * `aurica-sandbox run -- <cmd>` to forward an interactive command into
   * the VM with proxy env vars set.
   *
   * Does **not** reject on non-zero exit: the caller wants the exit code
   * to flow back to its own process. Rejection should be reserved for
   * provider-level failures (the binary is missing, the VM doesn't exist,
   * etc).
   */
  runOneShot: (args: {
    name: string;
    argv: string[];
    env?: Record<string, string>;
  }) => Promise<number>;
}
