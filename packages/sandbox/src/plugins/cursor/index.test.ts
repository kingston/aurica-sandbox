import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  expandPlugins,
  type ProjectPlugins,
  type UserPlugins,
} from '../index.js';
import * as hostCursor from './host-cursor.js';

const ctx = {
  linuxUser: 'sandbox',
  sandboxName: 'sb-test',
  authSecret: 'test-secret',
};
const project: ProjectPlugins = { cursor: {} };
const emptyUser: UserPlugins = {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('expandPlugins — cursor', () => {
  it('contributes the cursor remote-SSH domain allowlist and excludes telemetry hosts', () => {
    vi.spyOn(hostCursor, 'readHostCursor').mockReturnValue(null);
    const expanded = expandPlugins(project, emptyUser, ctx);
    expect(expanded.domains).toEqual(
      expect.arrayContaining([
        'downloads.cursor.com',
        'api2.cursor.sh',
        'api3.cursor.sh',
        'repo42.cursor.sh',
        'marketplace.cursorapi.com',
      ]),
    );
    expect(expanded.domains).not.toContain('mobile.events.data.microsoft.com');
    expect(expanded.domains).not.toContain('default.exp-tas.com');
    expect(expanded.policies).toEqual([]);
  });

  it('emits no commands and no bootstrap when host Cursor is undetectable', () => {
    vi.spyOn(hostCursor, 'readHostCursor').mockReturnValue(null);
    const expanded = expandPlugins(project, emptyUser, ctx);
    expect(expanded.commands).toEqual([]);
    expect(expanded.bootstrapScript).toBe('');
  });

  it('emits a post-lockdown pre-warm command (default user, no bootstrap) when host Cursor is detected', () => {
    vi.spyOn(hostCursor, 'readHostCursor').mockReturnValue({
      commit: '3e548838cf824b70851dd3ef27d0c6aae371b3f6',
      arch: 'arm64',
    });
    const expanded = expandPlugins(project, emptyUser, ctx);

    // Pre-warm is a post-lockdown command, not a root bootstrap script —
    // the REH server lives in the user's home, and the proxy already
    // allows downloads.cursor.com from the VM.
    expect(expanded.bootstrapScript).toBe('');
    expect(expanded.commands).toHaveLength(1);
    const cmd = expanded.commands[0];
    if (!cmd) throw new Error('expected one command');
    expect(cmd.user).toBe('default');
    expect(cmd.argv[0]).toBe('sh');
    expect(cmd.argv[1]).toBe('-c');
    // Commit + arch are positional args, never interpolated into the script body.
    expect(cmd.argv.at(-2)).toBe('3e548838cf824b70851dd3ef27d0c6aae371b3f6');
    expect(cmd.argv.at(-1)).toBe('arm64');
    const script = cmd.argv[2] ?? '';
    expect(script).toContain('$HOME/.cursor-server/bin/$commit');
    expect(script).toContain('cursor-reh-linux-$arch.tar.gz');
    expect(script).toContain(
      'downloads.cursor.com/production/$commit/linux/$arch',
    );
    // Skipped when the per-commit cache dir is already populated.
    expect(script).toContain('-x "$dest/bin/cursor-server"');
    // The script body must never contain the literal commit hash — that
    // would mean it was being interpolated rather than passed as $1.
    expect(script).not.toContain('3e548838cf824b70851dd3ef27d0c6aae371b3f6');
  });

  it('uses the x64 arch positional when host is x64', () => {
    vi.spyOn(hostCursor, 'readHostCursor').mockReturnValue({
      commit: '3e548838cf824b70851dd3ef27d0c6aae371b3f6',
      arch: 'x64',
    });
    const expanded = expandPlugins(project, emptyUser, ctx);
    const cmd = expanded.commands[0];
    expect(cmd?.argv.at(-1)).toBe('x64');
  });
});
