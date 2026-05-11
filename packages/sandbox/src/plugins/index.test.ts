import { describe, expect, it } from 'vitest';

import type { ProxyPolicy } from '#src/config/index.js';

import { expandPlugins, pluginDomainsForGitCoverage } from './index.js';
import type { Plugin } from './schema.js';

const ctx = { user: 'sandbox' };

/**
 * Pull the placeholder string a github plugin's policies use. Every github
 * allow policy carries `replace-header` mutations on `Authorization`; their
 * `from` is the deterministic placeholder, their `to` is the credential
 * source.
 */
function placeholderOf(policy: ProxyPolicy): string {
  if (policy.action.type !== 'allow' || !policy.action.mutations) {
    throw new Error('expected allow action with mutations');
  }
  const mut = policy.action.mutations[0];
  if (mut?.kind !== 'replace-header') {
    throw new Error('expected replace-header mutation');
  }
  return mut.from;
}

/** Filter to the policies that actually inject credentials (skip block/no-op). */
function allowPolicies(policies: readonly ProxyPolicy[]): ProxyPolicy[] {
  return policies.filter((p) => p.action.type === 'allow');
}

describe('expandPlugins', () => {
  it('derives a unique placeholder per plugin', () => {
    // Two distinct plugin configs must produce different placeholders.
    // Expanded separately because at most one github plugin per sandbox
    // may contribute a project-init cwd.
    const i1: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN_1',
    };
    const i2: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN_2',
    };
    const a = expandPlugins([i1], ctx);
    const b = expandPlugins([i2], ctx);
    const aFirst = allowPolicies(a.policies)[0];
    const bFirst = allowPolicies(b.policies)[0];
    if (!aFirst || !bFirst) throw new Error('expected allow policies');
    expect(placeholderOf(aFirst)).not.toBe(placeholderOf(bFirst));
  });

  it('derives the same placeholder across calls for identical plugin config', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const a = expandPlugins([plugin], ctx);
    const b = expandPlugins([plugin], ctx);
    const aFirst = allowPolicies(a.policies)[0];
    const bFirst = allowPolicies(b.policies)[0];
    if (!aFirst || !bFirst) throw new Error('expected allow policies');
    expect(placeholderOf(aFirst)).toBe(placeholderOf(bFirst));
  });

  it('returns empty result when no plugins are provided', () => {
    const expanded = expandPlugins([], ctx);
    expect(expanded.domains).toEqual([]);
    expect(expanded.policies).toEqual([]);
    expect(expanded.commands).toEqual([]);
    expect(expanded.bootstrapScript).toBe('');
  });

  it('concatenates bootstrap snippets in declared order', () => {
    const plugins: Plugin[] = [{ type: 'docker' }, { type: 'mise' }];
    const expanded = expandPlugins(plugins, ctx);
    const dockerIdx = expanded.bootstrapScript.indexOf('docker plugin');
    const miseIdx = expanded.bootstrapScript.indexOf('mise plugin');
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(miseIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeLessThan(miseIdx);

    const reversed = expandPlugins([{ type: 'mise' }, { type: 'docker' }], ctx);
    expect(reversed.bootstrapScript.indexOf('mise plugin')).toBeLessThan(
      reversed.bootstrapScript.indexOf('docker plugin'),
    );
  });

  it('dedupes domains across plugins', () => {
    const plugins: Plugin[] = [{ type: 'docker' }, { type: 'docker' }];
    const expanded = expandPlugins(plugins, ctx);
    expect(new Set(expanded.domains).size).toBe(expanded.domains.length);
  });

  it('docker plugin contributes the apt repo and Docker Hub domains', () => {
    const expanded = expandPlugins([{ type: 'docker' }], ctx);
    expect(expanded.domains).toEqual(
      expect.arrayContaining([
        'download.docker.com',
        'registry-1.docker.io',
        'auth.docker.io',
      ]),
    );
    expect(expanded.bootstrapScript).toMatch(/usermod -aG docker sandbox/);
    expect(expanded.commands).toEqual([]);
    expect(expanded.policies).toEqual([]);
  });

  it('mise plugin contributes the apt repo + language CDN domains', () => {
    const expanded = expandPlugins([{ type: 'mise' }], ctx);
    expect(expanded.domains).toEqual(
      expect.arrayContaining([
        'mise.en.dev',
        'mise.jdx.dev',
        'nodejs.org',
        'pypi.org',
      ]),
    );
    // Install path: official apt repo (signed-by the mise GPG key), not the
    // curl-piped installer. Putting the binary at /usr/bin/mise means every
    // shell finds it on PATH regardless of login state.
    expect(expanded.bootstrapScript).toMatch(/mise.en.dev\/gpg-key\.pub/);
    expect(expanded.bootstrapScript).toMatch(
      /apt-get install -y --no-install-recommends mise/,
    );
    // Activation shim is appended idempotently for bash, zsh, and fish so
    // interactive shells inside the VM pick up mise-managed tools.
    expect(expanded.bootstrapScript).toMatch(/mise activate bash/);
    expect(expanded.bootstrapScript).toMatch(/mise activate zsh/);
    expect(expanded.bootstrapScript).toMatch(/mise activate fish/);
    expect(expanded.bootstrapScript).toMatch(/grep -qxF/);
  });

  it('rejects unsafe usernames at expansion time', () => {
    expect(() =>
      expandPlugins([{ type: 'docker' }], { user: 'bad; rm -rf /' }),
    ).toThrow(/user/);
    expect(() =>
      expandPlugins([{ type: 'mise' }], { user: '$(whoami)' }),
    ).toThrow(/user/);
  });
});

describe('expandPlugins — github checkout / projectInitCwdOverride', () => {
  it('clones every listed repo to /workspaces/<repo>, writes AURICA_PROJECT_DIR to /etc/environment, and sets projectInitCwdOverride to the first repo', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    const cloneCmd = expanded.commands.find((c) =>
      c.argv.some((a) => a.includes('git clone')),
    );
    expect(cloneCmd).toEqual({
      user: 'default',
      argv: [
        'sh',
        '-c',
        'test -d "$2/.git" || git clone "$1" "$2"',
        'sh',
        'https://github.com/foo/bar.git',
        '/workspaces/bar',
      ],
    });

    const envCmd = expanded.commands.find((c) =>
      c.argv.some((a) => a.includes('AURICA_PROJECT_DIR')),
    );
    expect(envCmd?.user).toBe('root');
    expect(envCmd?.argv.at(-1)).toBe('/workspaces/bar');

    expect(expanded.projectInitCwdOverride).toBe('/workspaces/bar');
  });

  it('clones all repositories in order and picks the first entry as the primary', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [
        { name: 'a/primary' },
        { name: 'a/secondary' },
        { name: 'a/tertiary' },
      ],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    const cloneDests = expanded.commands
      .filter((c) => c.argv.some((a) => a.includes('git clone')))
      .map((c) => c.argv.at(-1));
    expect(cloneDests).toEqual([
      '/workspaces/primary',
      '/workspaces/secondary',
      '/workspaces/tertiary',
    ]);
    expect(expanded.projectInitCwdOverride).toBe('/workspaces/primary');
  });

  it('throws when two github plugins both contribute a projectInitCwdOverride', () => {
    const a: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'org-a/repo' }],
      tokenSource: 'env:TOKEN_A',
    };
    const b: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'org-b/repo' }],
      tokenSource: 'env:TOKEN_B',
    };
    expect(() => expandPlugins([a, b], ctx)).toThrow(/projectInitCwdOverride/);
  });
});

describe('pluginDomainsForGitCoverage', () => {
  it('returns github hosts only for github plugins', () => {
    expect(
      pluginDomainsForGitCoverage({
        type: 'github',
        username: 'x-access-token',
        repositories: [{ name: 'a/b' }],
        tokenSource: 'env:T',
      }),
    ).toEqual(['github.com', 'api.github.com', 'codeload.github.com']);
  });

  it('returns nothing for docker / mise / claude-code plugins', () => {
    expect(pluginDomainsForGitCoverage({ type: 'docker' })).toEqual([]);
    expect(pluginDomainsForGitCoverage({ type: 'mise' })).toEqual([]);
    expect(
      pluginDomainsForGitCoverage({
        type: 'claude-code',
        authMode: 'api-key',
      }),
    ).toEqual([]);
  });
});
