import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { CliCommandContext } from '#src/plugins/types.js';
import type { SandboxVMProvider } from '#src/vm/types.js';

import {
  buildCursorRemoteArgs,
  registerCursorCommands,
} from './cursor-commands.js';

describe('buildCursorRemoteArgs', () => {
  it('prefixes the provider SSH host with Cursor`s ssh-remote authority', () => {
    expect(buildCursorRemoteArgs('my-sandbox@orb', '/workspaces/repo')).toEqual(
      ['--remote', 'ssh-remote+my-sandbox@orb', '/workspaces/repo'],
    );
  });

  it('omits the path argument when no remote project dir is known', () => {
    expect(buildCursorRemoteArgs('my-sandbox@orb')).toEqual([
      '--remote',
      'ssh-remote+my-sandbox@orb',
    ]);
  });
});

describe('registerCursorCommands', () => {
  it('registers a `cursor` subcommand taking an optional name', () => {
    const program = new Command();
    const ctx = {
      provider: {} as SandboxVMProvider,
    } as CliCommandContext;
    registerCursorCommands(program, ctx);
    const cursor = program.commands.find((c) => c.name() === 'cursor');
    expect(cursor).toBeDefined();
    // `[name]` — optional positional, so the command parses with zero args.
    expect(cursor?.registeredArguments[0]?.required).toBe(false);
  });
});
