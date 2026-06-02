#!/usr/bin/env node
import { existsSync } from 'node:fs';
import process from 'node:process';

import { Command } from 'commander';

import { runCreate } from '#src/cli/commands/create.js';
import { runDestroy } from '#src/cli/commands/destroy.js';
import { runFork } from '#src/cli/commands/fork.js';
import { runInit } from '#src/cli/commands/init.js';
import { runList } from '#src/cli/commands/list.js';
import { runProxyLog, runProxyTail } from '#src/cli/commands/proxy-log.js';
import {
  runProxyRun,
  runProxyStart,
  runProxyStop,
} from '#src/cli/commands/proxy.js';
import { runRebuild } from '#src/cli/commands/rebuild.js';
import { runRun } from '#src/cli/commands/run.js';
import { runShell } from '#src/cli/commands/shell.js';
import { runStart } from '#src/cli/commands/start.js';
import { runStop } from '#src/cli/commands/stop.js';
import { runUpdate } from '#src/cli/commands/update.js';
import { projectEnvPath } from '#src/config/paths.js';
import { loadUserConfig } from '#src/config/user.js';
import { logger } from '#src/logger.js';
import { PLUGINS } from '#src/plugins/index.js';

const envPath = projectEnvPath(process.cwd());
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const program = new Command();

program
  .name('aurica-sandbox')
  .description('Ephemeral coding-agent VMs with restricted egress')
  .showHelpAfterError();

const verboseFlag =
  'log every request decision (matched policy, outcome, mutations, originating IP) and allowlist denials';

const proxy = program.command('proxy').description('manage the host proxy');

proxy
  .command('run')
  .description('run the host proxy in the foreground (long-running)')
  .option('-v, --verbose', verboseFlag, false)
  .action(async (opts: { verbose: boolean }) => {
    await runProxyRun({ verbose: opts.verbose });
  });

proxy
  .command('start')
  .description('start the host proxy as a background daemon')
  .option('-v, --verbose', verboseFlag, false)
  .action(async (opts: { verbose: boolean }) => {
    await runProxyStart({ verbose: opts.verbose });
  });

proxy
  .command('stop')
  .description('stop the background proxy daemon')
  .action(async () => {
    await runProxyStop();
  });

proxy
  .command('log')
  .description('print the tail of the proxy log and exit')
  .option('-n, --lines <n>', 'number of trailing lines to show', '100')
  .action(async (opts: { lines: string }) => {
    await runProxyLog({ lines: Number(opts.lines) });
  });

proxy
  .command('tail')
  .description('follow the proxy log live (Ctrl-C to stop)')
  .option('-n, --lines <n>', 'number of trailing lines to show first', '100')
  .action(async (opts: { lines: string }) => {
    await runProxyTail({ lines: Number(opts.lines) });
  });

// Bare `aurica-sandbox proxy` keeps running in the foreground for back-compat.
proxy
  .option('-v, --verbose', verboseFlag, false)
  .action(async (opts: { verbose: boolean }) => {
    await runProxyRun({ verbose: opts.verbose });
  });

program
  .command('init')
  .description('scaffold .aurica/sandbox.json')
  .action(async () => {
    await runInit(process.cwd());
  });

program
  .command('create [name]')
  .description(
    'create a primary sandbox VM and run init (defaults to the `name` field in .aurica/sandbox.json); VM is stopped after init and ready to fork',
  )
  .option('--start', 'leave the VM running after init instead of stopping it')
  .action(async (name: string | undefined, opts: { start: boolean }) => {
    await runCreate(process.cwd(), name, { start: opts.start });
  });

program
  .command('fork [name]')
  .description(
    'clone the project primary into a new running fork (default name: <primary>-fork-<N>)',
  )
  .option('--branch <branch>', 'branch hint passed to setup-fork.sh hooks', '')
  .action(async (name: string | undefined, opts: { branch: string }) => {
    await runFork(process.cwd(), name, { branch: opts.branch });
  });

program
  .command('update [name]')
  .description(
    'run update.sh hooks against an existing sandbox to refresh it without rebuilding (defaults to the project primary)',
  )
  .action(async (name: string | undefined) => {
    await runUpdate(process.cwd(), name);
  });

program
  .command('rebuild [name]')
  .description(
    'destroy and recreate a sandbox VM (use after editing sandbox.json or to recover from failed init)',
  )
  .action(async (name: string | undefined) => {
    await runRebuild(process.cwd(), name);
  });

program
  .command('start [name]')
  .description(
    'resume a previously stopped sandbox VM (defaults to the project primary)',
  )
  .action(async (name: string | undefined) => {
    await runStart(process.cwd(), name);
  });

program
  .command('stop [name]')
  .description(
    'pause a running sandbox VM (preserves disk; resume with `start`; defaults to the project primary)',
  )
  .action(async (name: string | undefined) => {
    await runStop(process.cwd(), name);
  });

program
  .command('destroy [name]')
  .description(
    'destroy a sandbox (defaults to the project primary; primaries with live forks require --cascade)',
  )
  .option('-f, --force', 'destroy even if not registered', false)
  .option(
    '--cascade',
    'also destroy all forks when destroying a primary',
    false,
  )
  .action(
    async (
      name: string | undefined,
      opts: { force: boolean; cascade: boolean },
    ) => {
      await runDestroy(process.cwd(), name, opts.force, opts.cascade);
    },
  );

program
  .command('list')
  .description('list registered sandboxes')
  .action(async () => {
    await runList();
  });

program
  .command('shell [name]')
  .description('ssh into the sandbox (defaults to the project primary)')
  .action(async (name: string | undefined) => {
    const code = await runShell(process.cwd(), name);
    process.exit(code);
  });

program
  .command('run [name] [args...]')
  .description(
    'run a command inside the sandbox (defaults to the project primary; use -- to separate args)',
  )
  .allowUnknownOption(true)
  .action(async () => {
    // Resolve name vs command from the raw argv rather than Commander's
    // bound positionals: Commander strips `--` before binding, which makes
    // `run -- cmd` indistinguishable from `run cmd` at the action layer.
    // A name is recognized only when a token precedes `--`; otherwise the
    // whole tail is the command, run against the project primary
    // (`run -- cmd` and `run cmd` both target the primary).
    const tail = process.argv.slice(process.argv.indexOf('run') + 1);
    const dashIdx = tail.indexOf('--');
    if (dashIdx > 1) {
      throw new Error(
        'usage: aurica-sandbox run [name] -- <cmd...> (only one name may precede `--`)',
      );
    }
    const targetName = dashIdx > 0 ? tail[0] : undefined;
    const commandArgv = dashIdx === -1 ? tail : tail.slice(dashIdx + 1);
    if (commandArgv.length === 0) {
      throw new Error('usage: aurica-sandbox run [name] -- <cmd...>');
    }
    const code = await runRun(process.cwd(), targetName, commandArgv);
    process.exit(code);
  });

// Plugin-contributed subcommands (e.g. `aurica-sandbox mcp login`). Each
// plugin's `cliCommands` hook is invoked once at startup, in registry
// order, regardless of whether any project has opted into the plugin —
// host-side management commands need to be callable without a project
// config loaded. Hooks may be async; each one is awaited before
// `parseAsync` so subcommands are present by the time argv runs. The
// `loadUserConfig` thunk is injected so plugins don't have to
// dynamic-import it themselves — bin is outside the plugin-graph init
// cycle, so it can value-import the loader directly.
for (const plugin of PLUGINS) {
  await plugin.cliCommands?.(program, { loadUserConfig });
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message);
  process.exit(1);
}
