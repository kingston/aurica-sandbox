#!/usr/bin/env node
import process from 'node:process';

import { Command } from 'commander';

import { runCa } from '#src/cli/commands/ca.js';
import { runCreate } from '#src/cli/commands/create.js';
import { runDestroy } from '#src/cli/commands/destroy.js';
import { runInit } from '#src/cli/commands/init.js';
import { runList } from '#src/cli/commands/list.js';
import { runRebuild } from '#src/cli/commands/rebuild.js';
import { runRun } from '#src/cli/commands/run.js';
import { runShell } from '#src/cli/commands/shell.js';
import { runStart } from '#src/cli/commands/start.js';
import { runStop } from '#src/cli/commands/stop.js';
import { logger } from '#src/logger.js';
import { runProxyProcess } from '#src/proxy/index.js';

const program = new Command();

program
  .name('aurica-sandbox')
  .description('Ephemeral coding-agent VMs with restricted egress')
  .showHelpAfterError();

program
  .command('proxy')
  .description('run the host proxy (foreground; long-running)')
  .action(async () => {
    await runProxyProcess();
    await new Promise<never>(() => {
      /* run forever */
    });
  });

program
  .command('init')
  .description('scaffold .aurica/sandbox.json')
  .action(async () => {
    await runInit(process.cwd());
  });

program
  .command('ca')
  .description('print the proxy CA certificate (PEM) to stdout')
  .action(async () => {
    await runCa();
  });

program
  .command('create [name]')
  .description(
    'create a sandbox VM and run init (default name: <folder>-<branch>)',
  )
  .action(async (name: string | undefined) => {
    await runCreate(process.cwd(), name);
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
  .command('start <name>')
  .description('resume a previously stopped sandbox VM')
  .action(async (name: string) => {
    await runStart(name);
  });

program
  .command('stop <name>')
  .description(
    'pause a running sandbox VM (preserves disk; resume with `start`)',
  )
  .action(async (name: string) => {
    await runStop(name);
  });

program
  .command('destroy <name>')
  .description('destroy a sandbox')
  .option('-f, --force', 'destroy even if not registered', false)
  .action(async (name: string, opts: { force: boolean }) => {
    await runDestroy(name, opts.force);
  });

program
  .command('list')
  .description('list registered sandboxes')
  .action(async () => {
    await runList();
  });

program
  .command('shell <name>')
  .description('ssh into the sandbox')
  .action(async (name: string) => {
    const code = await runShell(name);
    process.exit(code);
  });

program
  .command('run <name> [args...]')
  .description('run a command inside the sandbox (use -- to separate args)')
  .allowUnknownOption(true)
  .action(async (name: string, args: string[]) => {
    if (args.length === 0) {
      throw new Error('usage: aurica-sandbox run <name> -- <cmd...>');
    }
    const code = await runRun(name, args);
    process.exit(code);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message);
  process.exit(1);
}
