import { execa } from 'execa';
import { z } from 'zod';

import type {
  CreateVMOptions,
  HostBridgeIp,
  SandboxVM,
  SandboxVMProvider,
  VMExec,
} from '#src/vm/types.js';

import { orbBootstrapScript } from './bootstrap-script.js';
import { discoverOrbBridgeIp } from './bridge-ip.js';
import { createOrbExec } from './init.js';

const recordSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.object({
    distro: z.string(),
    version: z.string(),
    arch: z.string(),
    variant: z.string().optional(),
  }),
  state: z.enum(['creating', 'starting', 'running', 'stopping', 'stopped']),
  builtin: z.boolean().optional(),
  config: z.unknown().optional(),
});

const infoSchema = z.object({
  record: recordSchema,
  disk_size: z.number().optional(),
  ip4: z.string().optional(),
  ip6: z.string().optional(),
});

const listSchema = z.array(recordSchema);

type OrbRecord = z.infer<typeof recordSchema>;

async function orbctlText(...args: string[]): Promise<string> {
  const { stdout } = await execa('orbctl', args);
  return stdout;
}

async function orbctlJson<T>(
  schema: z.ZodType<T>,
  ...args: string[]
): Promise<T> {
  const stdout = await orbctlText(...args, '--format', 'json');
  const parsed: unknown = JSON.parse(stdout);
  return schema.parse(parsed);
}

function recordToSandboxVM(
  record: OrbRecord,
  ip4?: string,
  ip6?: string,
): SandboxVM {
  if (!ip4 && !ip6) {
    return { name: record.name };
  }
  const networkInfo: { ipV4: string; ipV6?: string } = { ipV4: ip4 ?? '' };
  if (ip6) networkInfo.ipV6 = ip6;
  return { name: record.name, networkInfo };
}

/**
 * `SandboxVMProvider` backed by the local OrbStack `orbctl` CLI.
 *
 * Requires `orbctl` to be installed and on `PATH`. All methods shell out
 * synchronously to the binary and surface its non-zero exits as `ExecaError`s.
 */
export const orbProvider: SandboxVMProvider = {
  /**
   * Create a new isolated OrbStack machine. Lifecycle only — provisioning
   * is run separately by the orchestrator in `vm/init/run-init.ts` after
   * `createVM` returns.
   *
   * `--isolated` is always passed: sandbox VMs must not share the host
   * filesystem or integrate with macOS networking. Defaults `distro` to
   * `'ubuntu'` (orbctl requires a distro positional). `mounts` entries
   * are forwarded as repeated `--mount` flags; orbctl requires
   * `--isolated` for them (already satisfied).
   *
   * Throws if a machine with the same `name` already exists.
   */
  async createVM({
    name,
    distro,
    arch,
    mounts,
  }: CreateVMOptions): Promise<SandboxVM> {
    const args: string[] = ['create', '--isolated', '--isolate-network'];
    if (arch) args.push('-a', arch);
    if (mounts) {
      for (const mount of mounts) args.push('--mount', mount);
    }
    args.push(distro ?? 'ubuntu', name);
    await orbctlText(...args);
    return orbProvider.infoVM(name);
  },

  /**
   * Clone a stopped OrbStack machine into a new machine with `destName`. The
   * source machine is paused briefly while OrbStack snapshots it; it returns
   * to its previous state (stopped) once cloning completes. The new machine
   * starts in the stopped state — call `startVM` to boot it.
   *
   * OrbStack implements clone as copy-on-write: no extra disk is consumed
   * until the clone diverges from the source.
   */
  async cloneVM(sourceName: string, destName: string): Promise<SandboxVM> {
    await orbctlText('clone', sourceName, destName);
    return { name: destName };
  },

  /**
   * Permanently delete an OrbStack machine by name. Stops it first if running.
   * Uses `orbctl delete -f` so it never prompts. Throws if no such machine.
   */
  async destroyVM(name: string): Promise<void> {
    await orbctlText('delete', '-f', name);
  },

  /**
   * Resume a stopped OrbStack machine by name via `orbctl start`. Returns
   * the latest VM info — note that the IP may not be populated yet at the
   * moment this resolves; callers polling for connectivity should retry
   * `infoVM` until `networkInfo.ipV4` is set.
   */
  async startVM(name: string): Promise<SandboxVM> {
    await orbctlText('start', name);
    return orbProvider.infoVM(name);
  },

  /**
   * Pause a running OrbStack machine by name via `orbctl stop`. The machine
   * keeps its disk; it can be resumed later with `startVM`. Throws if no
   * such machine exists.
   */
  async stopVM(name: string): Promise<void> {
    await orbctlText('stop', name);
  },

  /**
   * Look up a single machine by name. Populates `networkInfo` from the
   * `ip4`/`ip6` fields orbctl returns for running VMs; stopped machines
   * come back with `networkInfo` omitted.
   */
  async infoVM(name: string): Promise<SandboxVM> {
    const info = await orbctlJson(infoSchema, 'info', name);
    return recordToSandboxVM(info.record, info.ip4, info.ip6);
  },

  /**
   * List all OrbStack machines.
   *
   * `orbctl list` does not include IP addresses in its output, so every
   * returned `SandboxVM` will have `networkInfo` omitted regardless of
   * running state. Call `infoVM(name)` on a specific entry to fetch IPs.
   */
  async listVMs(): Promise<SandboxVM[]> {
    const records = await orbctlJson(listSchema, 'list');
    return records.map((r) => recordToSandboxVM(r));
  },

  /**
   * Resolve the host's IPv4 on OrbStack's machine bridge. See
   * {@link discoverOrbBridgeIp} for the full strategy; this method just
   * wires the provider's own `listVMs`/`infoVM` into it.
   */
  discoverHostBridgeIp(): Promise<HostBridgeIp> {
    return discoverOrbBridgeIp({
      listVMs: () => orbProvider.listVMs(),
      infoVM: (name) => orbProvider.infoVM(name),
    });
  },

  /**
   * Build an {@link VMExec} backed by `orbctl run` for a single OrbStack VM.
   * See {@link createOrbExec} for boot-readiness polling and the
   * tar-over-stdin push protocol used to work around `orbctl push`'s
   * incompatibility with `--isolated` machines.
   */
  createExec(name: string, defaultUser: string): VMExec {
    return createOrbExec(name, defaultUser);
  },

  bootstrapScript: orbBootstrapScript,

  /**
   * Forward `argv` into an OrbStack VM via `orbctl run -m <name> -e K=V …`
   * with stdio inherited. Resolves with the child's exit code; never
   * rejects on a non-zero exit. Throws if `orbctl` itself fails to launch.
   */
  async runOneShot({
    name,
    argv,
    env,
  }: {
    name: string;
    argv: string[];
    env?: Record<string, string>;
  }): Promise<number> {
    const envArgs = env
      ? Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      : [];
    const result = await execa(
      'orbctl',
      ['run', '-m', name, ...envArgs, '--', ...argv],
      { reject: false, stdio: 'inherit' },
    );
    return result.exitCode ?? 1;
  },
};
