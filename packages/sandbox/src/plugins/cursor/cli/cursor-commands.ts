import { spawn } from 'node:child_process';

import type { Command } from 'commander';

import { logger } from '#src/logger.js';
import type { CliCommandContext } from '#src/plugins/types.js';

/**
 * Build the argv for the host `cursor` CLI that opens a remote-SSH window.
 * `sshHost` is the provider-supplied SSH host authority (e.g. OrbStack's
 * `<name>@orb`); `ssh-remote+` is Cursor/VS Code's own remote-authority
 * convention. When `remotePath` is given the window opens there; otherwise
 * it's omitted and Cursor opens at the remote user's `$HOME`.
 */
export function buildCursorRemoteArgs(
  sshHost: string,
  remotePath?: string,
): string[] {
  const args = ['--remote', `ssh-remote+${sshHost}`];
  if (remotePath) args.push(remotePath);
  return args;
}

/**
 * `aurica-sandbox cursor [name]` — open a Cursor remote-SSH window onto the
 * sandbox VM. Ensures the VM is running first (Cursor's remote-SSH cannot
 * attach to a stopped machine), then spawns the host `cursor` CLI with
 * `--remote ssh-remote+<host> <path>`.
 *
 * The remote path is the in-VM project directory recorded on the sandbox's
 * state entry at create time (`vmProjectDir`); when absent — no plugin set
 * a project dir, or the entry predates that field — the path is omitted and
 * Cursor opens at the remote user's `$HOME`. The SSH host comes from the
 * provider, so this stays free of provider-specific (e.g. OrbStack)
 * references.
 *
 * When `nameArg` is omitted, targets the project's primary sandbox. The
 * `cursor` process forks a GUI window and detaches, so this resolves as
 * soon as the launcher has been spawned rather than awaiting its exit.
 */
export async function runCursor(
  ctx: Pick<CliCommandContext, 'provider'>,
  projectDir: string,
  nameArg?: string,
): Promise<void> {
  const { provider } = ctx;

  // Deferred imports: this module is loaded at plugin-registry init time (the
  // `cursor` plugin top-level imports `registerCursorCommands`), and these
  // modules pull the config graph back into the registry. Importing them at
  // module-eval would re-enter the partially-initialized registry. See the
  // note on `CliCommandContext` in `plugins/types.ts`.
  const [
    { resolveTarget },
    { runStart },
    { readState },
    { assertPlatformSupported },
  ] = await Promise.all([
    import('#src/cli/commands/find-primary.js'),
    import('#src/cli/commands/start.js'),
    import('#src/state/index.js'),
    import('#src/vm/platform.js'),
  ]);

  assertPlatformSupported();

  // Cursor remote-SSH can't attach to a stopped machine; bring it up first.
  // `runStart` is a no-op when the sandbox is already running.
  await runStart(projectDir, nameArg);

  const state = await readState();
  const entry = resolveTarget(state, projectDir, nameArg);
  const name = entry.name;

  const remotePath = entry.vmProjectDir;
  const args = buildCursorRemoteArgs(provider.remoteSshHost(name), remotePath);

  logger.info(
    `Opening Cursor on ${name}${remotePath ? ` at ${remotePath}` : ''}`,
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn('cursor', args, {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Attach the `cursor` subcommand to a Commander root program. Called by the
 * `cursor` plugin's `cliCommands` hook; takes the framework
 * {@link CliCommandContext} to reach the active VM provider.
 */
export function registerCursorCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  program
    .command('cursor')
    .description('open a Cursor remote-SSH window onto a sandbox VM')
    .argument(
      '[name]',
      'sandbox name (defaults to the project primary sandbox)',
    )
    .action(async (name: string | undefined) => {
      await runCursor(ctx, process.cwd(), name);
    });
}
