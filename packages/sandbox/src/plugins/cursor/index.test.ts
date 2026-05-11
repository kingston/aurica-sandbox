import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  expandPlugins,
  type ProjectPlugins,
  type UserPlugins,
} from '../index.js';
import * as hostCursor from './host-cursor.js';

const ctx = { linuxUser: 'sandbox' };
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
    expect(expanded.commands).toEqual([]);
  });

  it('omits the bootstrap script when host Cursor is undetectable', () => {
    vi.spyOn(hostCursor, 'readHostCursor').mockReturnValue(null);
    const expanded = expandPlugins(project, emptyUser, ctx);
    expect(expanded.bootstrapScript).toBe('');
  });

  it('emits a pre-warm bootstrap snippet with the host commit and arch when detection succeeds', () => {
    vi.spyOn(hostCursor, 'readHostCursor').mockReturnValue({
      commit: '3e548838cf824b70851dd3ef27d0c6aae371b3f6',
      arch: 'arm64',
    });
    const expanded = expandPlugins(project, emptyUser, ctx);
    expect(expanded.bootstrapScript).toMatch(
      /commit="3e548838cf824b70851dd3ef27d0c6aae371b3f6"/,
    );
    expect(expanded.bootstrapScript).toMatch(/arch="arm64"/);
    expect(expanded.bootstrapScript).toMatch(
      /https:\/\/downloads\.cursor\.com\/production\/\$commit\/linux\/\$arch\/cursor-reh-linux-\$arch\.tar\.gz/,
    );
    expect(expanded.bootstrapScript).toMatch(
      /if \[ ! -x "\$dest\/bin\/cursor-server" \]/,
    );
    expect(expanded.bootstrapScript).toMatch(/sudo -iu sandbox bash -ls/);
  });

  it('uses the x64 tarball segment when host is x64', () => {
    vi.spyOn(hostCursor, 'readHostCursor').mockReturnValue({
      commit: '3e548838cf824b70851dd3ef27d0c6aae371b3f6',
      arch: 'x64',
    });
    const expanded = expandPlugins(project, emptyUser, ctx);
    expect(expanded.bootstrapScript).toMatch(/arch="x64"/);
  });

  it('rejects unsafe usernames at expansion time', () => {
    vi.spyOn(hostCursor, 'readHostCursor').mockReturnValue(null);
    expect(() =>
      expandPlugins(project, emptyUser, { linuxUser: 'bad; rm -rf /' }),
    ).toThrow(/linuxUser/);
  });
});
