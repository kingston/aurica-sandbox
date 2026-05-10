import { describe, expect, it } from 'vitest';

import type { ProxyPolicy } from '#src/config/index.js';

import { expandPlugins, pluginDomainsForGitCoverage } from './index.js';
import type { Plugin } from './schema.js';

const PLACEHOLDER_RE = /^__AURICA_TOKEN_[0-9A-F]{16}__$/;

const ctx = { user: 'sandbox' };

/**
 * Pull the placeholder string a github plugin's policies use. Every github
 * policy carries a single `replace-header` mutation; its `from` is the
 * deterministic placeholder, its `to` is the credential source.
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

describe('expandPlugins', () => {
  it('emits domains, coarse policies, and commands for one github plugin without permissions', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    expect(new Set(expanded.domains)).toEqual(
      new Set([
        'github.com',
        'api.github.com',
        'codeload.github.com',
        '*.githubusercontent.com',
        'cli.github.com',
      ]),
    );
    expect(expanded.policies).toHaveLength(3);
    const placeholders = new Set(expanded.policies.map(placeholderOf));
    expect(placeholders.size).toBe(1);
    const firstPolicy = expanded.policies[0];
    if (!firstPolicy) throw new Error('expected at least one policy');
    const placeholder = placeholderOf(firstPolicy);
    expect(placeholder).toMatch(PLACEHOLDER_RE);

    const byDomain: Record<string, ProxyPolicy> = Object.fromEntries(
      expanded.policies.map((p) => [p.domain, p]),
    );
    // Coarse policies use a single segment-boundary prefix matcher.
    expect(byDomain['github.com']?.matchers).toEqual([{ prefix: '/foo/bar' }]);
    expect(byDomain['api.github.com']?.matchers).toEqual([
      { prefix: '/repos/foo/bar' },
    ]);
    expect(byDomain['codeload.github.com']?.matchers).toEqual([
      { prefix: '/foo/bar' },
    ]);
    for (const policy of expanded.policies) {
      expect(policy.id).toBe(`github:foo/bar:${policy.domain}`);
      if (policy.action.type !== 'allow') throw new Error('expected allow');
      const mut = policy.action.mutations?.[0];
      if (mut?.kind !== 'replace-header') {
        throw new Error('expected replace-header mutation');
      }
      expect(mut.header).toBe('Authorization');
      expect(mut.transform).toEqual({
        type: 'base64',
        prefix: 'x-access-token:',
      });
    }

    expect(expanded.commands).toEqual([
      {
        user: 'default',
        argv: ['git', 'config', '--global', 'credential.helper', 'store'],
      },
      {
        user: 'default',
        argv: ['git', 'config', '--global', 'credential.useHttpPath', 'true'],
      },
      {
        user: 'default',
        argv: [
          'sh',
          '-c',
          String.raw`umask 077 && printf "%s\n" "$@" > "$HOME/.git-credentials"`,
          'sh',
          `https://x-access-token:${placeholder}@github.com/foo/bar`,
        ],
      },
    ]);
    expect(expanded.bootstrapScript).toMatch(
      /apt-get install -y --no-install-recommends gh/,
    );
  });

  it('expands multiple repos into N policies per host and one credentials write', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'a/b' }, { name: 'c/d' }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    expect(expanded.policies).toHaveLength(6);
    expect(expanded.commands).toHaveLength(3);
    const credsWrite = expanded.commands[2];
    expect(credsWrite?.argv[0]).toBe('sh');
    const firstPolicy = expanded.policies[0];
    if (!firstPolicy) throw new Error('expected at least one policy');
    const placeholder = placeholderOf(firstPolicy);
    const urls = credsWrite?.argv.slice(4) ?? [];
    expect(urls).toEqual([
      `https://x-access-token:${placeholder}@github.com/a/b`,
      `https://x-access-token:${placeholder}@github.com/c/d`,
    ]);
  });

  it('derives a unique placeholder per plugin', () => {
    const i1: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN_1',
    };
    const i2: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN_2',
    };
    const expanded = expandPlugins([i1, i2], ctx);

    const placeholders = new Set(expanded.policies.map(placeholderOf));
    expect(placeholders.size).toBe(2);
  });

  it('derives the same placeholder across calls for identical plugin config', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN',
    };
    const a = expandPlugins([plugin], ctx);
    const b = expandPlugins([plugin], ctx);
    const aFirst = a.policies[0];
    const bFirst = b.policies[0];
    if (!aFirst || !bFirst) throw new Error('expected policies');
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

  it('mise plugin contributes mise + language CDN domains', () => {
    const expanded = expandPlugins([{ type: 'mise' }], ctx);
    expect(expanded.domains).toEqual(
      expect.arrayContaining([
        'mise.run',
        'mise.jdx.dev',
        'nodejs.org',
        'pypi.org',
      ]),
    );
    expect(expanded.bootstrapScript).toMatch(
      /sudo -iu sandbox bash -lc 'curl -fsSL https:\/\/mise\.run \| sh'/,
    );
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

describe('expandPlugins — github permissions', () => {
  it('pullRequests:write emits one api.github.com policy and nothing for other hosts', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [
        { name: 'foo/bar', permissions: { pullRequests: 'write' } },
      ],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    expect(expanded.policies).toHaveLength(1);
    const policy = expanded.policies[0];
    if (!policy) throw new Error('expected policy');
    expect(policy.domain).toBe('api.github.com');
    expect(policy.id).toBe('github:foo/bar:api.github.com');

    // Matchers cover the pulls prefix for both read and write methods.
    const matchers = policy.matchers ?? [];
    expect(matchers).toContainEqual({
      prefix: '/repos/foo/bar/pulls',
      methods: ['GET'],
    });
    expect(matchers).toContainEqual({
      prefix: '/repos/foo/bar/pulls',
      methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    });
  });

  it('contents:read allows git-upload-pack but not git-receive-pack', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar', permissions: { contents: 'read' } }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    const githubCom = expanded.policies.find((p) => p.domain === 'github.com');
    if (!githubCom) throw new Error('expected github.com policy');
    const matchers = githubCom.matchers ?? [];
    // Allowed: info/refs GET and git-upload-pack POST.
    expect(matchers).toContainEqual({
      exact: '/foo/bar/info/refs',
      methods: ['GET'],
    });
    expect(matchers).toContainEqual({
      exact: '/foo/bar/git-upload-pack',
      methods: ['POST'],
    });
    // NOT allowed: git-receive-pack (push handshake payload).
    const hasReceivePack = matchers.some(
      (m) => 'exact' in m && m.exact === '/foo/bar/git-receive-pack',
    );
    expect(hasReceivePack).toBe(false);
  });

  it('contents:write adds git-receive-pack on top of read', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar', permissions: { contents: 'write' } }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    const githubCom = expanded.policies.find((p) => p.domain === 'github.com');
    if (!githubCom) throw new Error('expected github.com policy');
    const matchers = githubCom.matchers ?? [];
    expect(matchers).toContainEqual({
      exact: '/foo/bar/git-upload-pack',
      methods: ['POST'],
    });
    expect(matchers).toContainEqual({
      exact: '/foo/bar/git-receive-pack',
      methods: ['POST'],
    });
  });

  it('contents:write + pullRequests:write emits policies on all three hosts and unions matchers', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [
        {
          name: 'foo/bar',
          permissions: { contents: 'write', pullRequests: 'write' },
        },
      ],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    const hosts = new Set(expanded.policies.map((p) => p.domain));
    expect(hosts).toEqual(
      new Set(['github.com', 'api.github.com', 'codeload.github.com']),
    );

    const api = expanded.policies.find((p) => p.domain === 'api.github.com');
    if (!api) throw new Error('expected api.github.com policy');
    const apiMatchers = api.matchers ?? [];
    // Has both contents endpoints (e.g. /repos/foo/bar metadata) and pulls.
    expect(apiMatchers).toContainEqual({
      exact: '/repos/foo/bar',
      methods: ['GET'],
    });
    expect(apiMatchers).toContainEqual({
      prefix: '/repos/foo/bar/pulls',
      methods: ['GET'],
    });
  });

  it('empty permissions object emits zero policies but keeps github domains', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar', permissions: {} }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    expect(expanded.policies).toEqual([]);
    expect(new Set(expanded.domains)).toEqual(
      new Set([
        'github.com',
        'api.github.com',
        'codeload.github.com',
        '*.githubusercontent.com',
        'cli.github.com',
      ]),
    );
  });

  it('mixed repos: scoped and unscoped coexist in one plugin', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [
        { name: 'a/b' },
        { name: 'c/d', permissions: { pullRequests: 'read' } },
      ],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    // a/b → 3 coarse policies. c/d → 1 (api.github.com only).
    expect(expanded.policies).toHaveLength(4);
    const ids = expanded.policies.map((p) => p.id).sort();
    expect(ids).toEqual([
      'github:a/b:api.github.com',
      'github:a/b:codeload.github.com',
      'github:a/b:github.com',
      'github:c/d:api.github.com',
    ]);
  });
});

describe('pluginDomainsForGitCoverage', () => {
  it('returns github hosts only for github plugins', () => {
    expect(
      pluginDomainsForGitCoverage({
        type: 'github',
        username: 'x-access-token',
        repositories: [{ name: 'a/b' }],
        token: 'env:T',
      }),
    ).toEqual(['github.com', 'api.github.com', 'codeload.github.com']);
  });

  it('returns nothing for docker / mise plugins', () => {
    expect(pluginDomainsForGitCoverage({ type: 'docker' })).toEqual([]);
    expect(pluginDomainsForGitCoverage({ type: 'mise' })).toEqual([]);
  });
});
