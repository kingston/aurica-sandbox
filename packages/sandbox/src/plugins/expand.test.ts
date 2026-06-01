import { describe, expect, it } from 'vitest';

import {
  expandPlugins,
  githubDomainsForGitCoverage,
  type UserPlugins,
} from './index.js';

const ctx = {
  linuxUser: 'sandbox',
  sandboxName: 'sb-test',
  authSecret: 'test-secret',
};
const emptyUser: UserPlugins = {};

describe('expandPlugins', () => {
  it('returns empty result when no plugins are opted into', async () => {
    const expanded = await expandPlugins({}, emptyUser, ctx);
    expect(expanded.domains).toEqual([]);
    expect(expanded.policies).toEqual([]);
    expect(expanded.commands).toEqual([]);
    expect(expanded.bootstrapScript).toBe('');
    expect(expanded.enabledPlugins).toEqual([]);
  });

  it('concatenates bootstrap snippets in registry order regardless of config-file key order', async () => {
    // The registry orders github -> docker -> mise -> claude-code -> cursor;
    // expansion follows that order even if the project config lists keys in
    // a different sequence.
    const expanded = await expandPlugins(
      { mise: {}, docker: {} },
      emptyUser,
      ctx,
    );
    const dockerIdx = expanded.bootstrapScript.indexOf('docker plugin');
    const miseIdx = expanded.bootstrapScript.indexOf('mise plugin');
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(miseIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeLessThan(miseIdx);
    // enabledPlugins follows registry order (docker before mise) regardless
    // of the config-file key order.
    expect(expanded.enabledPlugins).toEqual(['docker', 'mise']);
  });

  it('rejects unsafe usernames at expansion time', async () => {
    await expect(
      expandPlugins({ docker: {} }, emptyUser, {
        ...ctx,
        linuxUser: 'bad; rm -rf /',
      }),
    ).rejects.toThrow(/linuxUser/);
    await expect(
      expandPlugins({ mise: {} }, emptyUser, {
        ...ctx,
        linuxUser: '$(whoami)',
      }),
    ).rejects.toThrow(/linuxUser/);
  });
});

describe('githubDomainsForGitCoverage', () => {
  it('returns github hosts when github is enabled', () => {
    expect(
      githubDomainsForGitCoverage({
        github: {
          username: 'x-access-token',
          repositories: [{ name: 'a/b' }],
          tokenSource: 'env:T',
        },
      }),
    ).toEqual(['github.com', 'api.github.com', 'codeload.github.com']);
  });

  it('returns nothing when github is not enabled', () => {
    expect(githubDomainsForGitCoverage({})).toEqual([]);
    expect(githubDomainsForGitCoverage({ docker: {} })).toEqual([]);
    expect(githubDomainsForGitCoverage({ mise: {} })).toEqual([]);
  });
});
