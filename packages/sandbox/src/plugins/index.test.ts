import { describe, expect, it } from 'vitest';

import type { ProxyPolicy } from '#src/config/index.js';

import { expandPlugins, pluginDomainsForGitCoverage } from './index.js';
import type { Plugin } from './schema.js';

const PLACEHOLDER_RE = /^__AURICA_TOKEN_[0-9A-F]{16}__$/;

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

function blockPolicies(policies: readonly ProxyPolicy[]): ProxyPolicy[] {
  return policies.filter((p) => p.action.type === 'block');
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
    // 3 allow (one per auth host) + 3 catch-all blocks (one per auth host).
    expect(expanded.policies).toHaveLength(6);
    const allows = allowPolicies(expanded.policies);
    const blocks = blockPolicies(expanded.policies);
    expect(allows).toHaveLength(3);
    expect(blocks).toHaveLength(3);
    const placeholders = new Set(allows.map(placeholderOf));
    expect(placeholders.size).toBe(1);
    const firstAllow = allows[0];
    if (!firstAllow) throw new Error('expected at least one allow policy');
    const placeholder = placeholderOf(firstAllow);
    expect(placeholder).toMatch(PLACEHOLDER_RE);

    const allowByDomain: Record<string, ProxyPolicy> = Object.fromEntries(
      allows.map((p) => [p.domain, p]),
    );
    // Coarse policies use a single segment-boundary prefix matcher.
    expect(allowByDomain['github.com']?.matchers).toEqual([
      { prefix: '/foo/bar' },
    ]);
    expect(allowByDomain['api.github.com']?.matchers).toEqual([
      { prefix: '/repos/foo/bar' },
    ]);
    expect(allowByDomain['codeload.github.com']?.matchers).toEqual([
      { prefix: '/foo/bar' },
    ]);
    for (const policy of allows) {
      expect(policy.id).toBe(`github:foo/bar:${policy.domain}`);
      if (policy.action.type !== 'allow') throw new Error('expected allow');
      const muts = policy.action.mutations ?? [];
      // Two mutations on Authorization: one for git Basic (with base64
      // transform), one for gh's plaintext `token <X>` form.
      expect(muts).toHaveLength(2);
      expect(muts[0]).toEqual({
        kind: 'replace-header',
        header: 'Authorization',
        from: placeholder,
        to: 'env:GITHUB_TOKEN',
        transform: { type: 'base64', prefix: 'x-access-token:' },
      });
      expect(muts[1]).toEqual({
        kind: 'replace-header',
        header: 'Authorization',
        from: placeholder,
        to: 'env:GITHUB_TOKEN',
      });
    }
    // Block policies catch any path/method outside the allow scope.
    const blockIds = blocks.map((p) => p.id).sort();
    expect(blockIds).toEqual([
      'github:block:api.github.com',
      'github:block:codeload.github.com',
      'github:block:github.com',
    ]);
    for (const policy of blocks) {
      expect(policy.matchers).toBeUndefined();
      expect(policy.action).toEqual({ type: 'block' });
    }

    expect(expanded.commands).toEqual([
      {
        user: 'default',
        argv: [
          'git',
          'config',
          '--global',
          'credential.helper',
          '/usr/local/bin/aurica-git-credential',
        ],
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
      {
        user: 'default',
        argv: [
          'sh',
          '-c',
          String.raw`mkdir -p "$HOME/.config/gh" && umask 077 && printf "%s\n" "$@" > "$HOME/.config/gh/hosts.yml"`,
          'sh',
          'github.com:',
          '    user: x-access-token',
          `    oauth_token: ${placeholder}`,
          '    git_protocol: https',
        ],
      },
    ]);
    expect(expanded.bootstrapScript).toMatch(
      /apt-get install -y --no-install-recommends gh/,
    );
    // Custom credential helper installed alongside gh CLI; `store` and
    // `erase` are no-ops so failed auth can't wipe ~/.git-credentials.
    expect(expanded.bootstrapScript).toMatch(
      /cat > \/usr\/local\/bin\/aurica-git-credential/,
    );
    expect(expanded.bootstrapScript).toMatch(
      /git credential-store --file "\$HOME\/\.git-credentials" get/,
    );
    expect(expanded.bootstrapScript).toMatch(/store\|erase\) exit 0/);
  });

  it('expands multiple repos into N allow policies per host plus catch-all blocks and one credentials write', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'a/b' }, { name: 'c/d' }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    // 2 repos × 3 hosts = 6 allows; +3 blocks (one per host) = 9.
    expect(expanded.policies).toHaveLength(9);
    expect(allowPolicies(expanded.policies)).toHaveLength(6);
    expect(blockPolicies(expanded.policies)).toHaveLength(3);
    // helper config (2) + credentials write + gh hosts.yml = 4 commands.
    expect(expanded.commands).toHaveLength(4);
    const credsWrite = expanded.commands[2];
    expect(credsWrite?.argv[0]).toBe('sh');
    const firstAllow = allowPolicies(expanded.policies)[0];
    if (!firstAllow) throw new Error('expected at least one allow policy');
    const placeholder = placeholderOf(firstAllow);
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

    const placeholders = new Set(
      allowPolicies(expanded.policies).map(placeholderOf),
    );
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

  it('mirrors plugin.user into the VM as `git config --global user.{name,email}`', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      user: { name: 'Ada Lovelace', email: 'ada@example.com' },
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    // user.name and user.email commands appear after the existing 4
    // (helper, useHttpPath, .git-credentials, hosts.yml).
    expect(expanded.commands).toHaveLength(6);
    expect(expanded.commands.slice(-2)).toEqual([
      {
        user: 'default',
        argv: ['git', 'config', '--global', 'user.name', 'Ada Lovelace'],
      },
      {
        user: 'default',
        argv: ['git', 'config', '--global', 'user.email', 'ada@example.com'],
      },
    ]);
  });

  it('emits no user-identity commands when plugin.user is omitted', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);
    const argvs = expanded.commands.map((c) => c.argv);
    expect(
      argvs.some(
        (argv) => argv.includes('user.name') || argv.includes('user.email'),
      ),
    ).toBe(false);
  });

  it('appends catch-all block policies after all allow policies (preserves first-match-wins)', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);
    // All allow indices must precede all block indices, otherwise the
    // catch-all block would shadow the allow at evaluation time.
    const indices = expanded.policies.map((p, i) => ({
      i,
      type: p.action.type,
    }));
    const lastAllow = Math.max(
      ...indices.filter((x) => x.type === 'allow').map((x) => x.i),
    );
    const firstBlock = Math.min(
      ...indices.filter((x) => x.type === 'block').map((x) => x.i),
    );
    expect(lastAllow).toBeLessThan(firstBlock);
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
  it('pullRequests:write emits one api.github.com allow policy and nothing else for the other auth hosts', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [
        { name: 'foo/bar', permissions: { pullRequests: 'write' } },
      ],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    const allows = allowPolicies(expanded.policies);
    expect(allows).toHaveLength(1);
    const policy = allows[0];
    if (!policy) throw new Error('expected allow policy');
    expect(policy.domain).toBe('api.github.com');
    expect(policy.id).toBe('github:foo/bar:api.github.com');
    // Catch-all blocks still cover all three auth hosts so non-PR paths are 403'd.
    expect(blockPolicies(expanded.policies)).toHaveLength(3);

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

    const githubCom = allowPolicies(expanded.policies).find(
      (p) => p.domain === 'github.com',
    );
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

    const githubCom = allowPolicies(expanded.policies).find(
      (p) => p.domain === 'github.com',
    );
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

    const allows = allowPolicies(expanded.policies);
    const hosts = new Set(allows.map((p) => p.domain));
    expect(hosts).toEqual(
      new Set(['github.com', 'api.github.com', 'codeload.github.com']),
    );

    const api = allows.find((p) => p.domain === 'api.github.com');
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

  it('empty permissions object emits no allow policies (only catch-all blocks) but keeps github domains', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar', permissions: {} }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    expect(allowPolicies(expanded.policies)).toEqual([]);
    expect(blockPolicies(expanded.policies)).toHaveLength(3);
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

    // a/b → 3 coarse allows. c/d → 1 (api.github.com only). +3 catch-all blocks.
    expect(expanded.policies).toHaveLength(7);
    const allowIds = allowPolicies(expanded.policies)
      .map((p) => p.id)
      .sort();
    expect(allowIds).toEqual([
      'github:a/b:api.github.com',
      'github:a/b:codeload.github.com',
      'github:a/b:github.com',
      'github:c/d:api.github.com',
    ]);
    const blockIds = blockPolicies(expanded.policies)
      .map((p) => p.id)
      .sort();
    expect(blockIds).toEqual([
      'github:block:api.github.com',
      'github:block:codeload.github.com',
      'github:block:github.com',
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
