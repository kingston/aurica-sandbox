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
const emptyUser: UserPlugins = {};

describe('misePlugin', () => {
  it('contributes the apt repo and language CDN domains', async () => {
    const expanded = await expandPlugins({ mise: {} }, emptyUser, ctx);
    expect(expanded.domains).toEqual(
      expect.arrayContaining([
        'mise.en.dev',
        'mise.jdx.dev',
        'nodejs.org',
        'pypi.org',
      ]),
    );
  });

  it('installs mise from the official apt repo and wires up shell activations', async () => {
    const expanded = await expandPlugins({ mise: {} }, emptyUser, ctx);
    expect(expanded.bootstrapScript).toMatch(/mise.en.dev\/gpg-key\.pub/);
    expect(expanded.bootstrapScript).toMatch(
      /apt-get install -y --no-install-recommends mise/,
    );
    expect(expanded.bootstrapScript).toMatch(/mise activate bash/);
    expect(expanded.bootstrapScript).toMatch(/mise activate zsh/);
    expect(expanded.bootstrapScript).toMatch(/mise activate fish/);
    expect(expanded.bootstrapScript).toMatch(/grep -qxF/);
  });

  it('emits no post-lockdown commands and no proxy policies', async () => {
    const expanded = await expandPlugins({ mise: {} }, emptyUser, ctx);
    expect(expanded.commands).toEqual([]);
    expect(expanded.policies).toEqual([]);
  });
});

describe('misePlugin — ProjectPlugins type', () => {
  it('accepts mise: {} (no config required)', async () => {
    const project: ProjectPlugins = { mise: {} };
    const expanded = await expandPlugins(project, emptyUser, ctx);
    expect(expanded.enabledPlugins).toContain('mise');
  });
});
