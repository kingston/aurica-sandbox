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
   * Push the contents of `localDir` into `<defaultUserHome>/<dest>` inside
   * the VM. Recursive. The destination directory is created if absent.
   */
  pushDir(localDir: string, dest: string): Promise<void>;

  /**
   * Run a command inside the VM. `user: 'root'` switches to root; `'default'`
   * uses the VM's default Linux user.
   */
  run(args: { user: 'root' | 'default'; argv: string[] }): Promise<void>;
}

export interface CreateVMOptions {
  name: string;
  distro?: 'ubuntu' | 'debian' | 'nixos';
  arch?: 'amd64' | 'arm64';
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
}
