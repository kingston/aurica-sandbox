import { describe, expect, it } from 'vitest';

import {
  expandPlugins,
  type ProjectPlugins,
  type UserPlugins,
} from '../index.js';

const ctx = {
  linuxUser: 'sandbox',
  sandboxName: 'sb-test',
  authSecret: 'test-secret',
};
const project: ProjectPlugins = { cursor: {} };
const emptyUser: UserPlugins = {};

describe('expandPlugins — cursor', () => {
  it('contributes the cursor remote-SSH domain allowlist and excludes telemetry hosts', async () => {
    const expanded = await expandPlugins(project, emptyUser, ctx);
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
  });

  it('contributes a response-cache policy for the content-addressed REH download', async () => {
    const expanded = await expandPlugins(project, emptyUser, ctx);
    expect(expanded.policies).toEqual([
      {
        id: 'cursor:reh-download-cache',
        description:
          'Cache the content-addressed Cursor REH tarball across sandboxes',
        domain: 'downloads.cursor.com',
        matchers: [{ prefix: '/production/', methods: ['GET'] }],
        action: {
          type: 'allow',
          cacheResponse: { ttlSeconds: 7 * 24 * 60 * 60 },
        },
      },
    ]);
  });

  it('emits no commands and no bootstrap script', async () => {
    const expanded = await expandPlugins(project, emptyUser, ctx);
    expect(expanded.commands).toEqual([]);
    expect(expanded.bootstrapScript).toBe('');
  });
});
