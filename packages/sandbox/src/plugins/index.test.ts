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
  it('emits domains, default fetch+push policies, and commands for one github plugin', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN',
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
    // 2 allow (github.com + codeload.github.com) + 3 catch-all blocks. No
    // api.github.com allow because `api` defaults to false.
    expect(expanded.policies).toHaveLength(5);
    const allows = allowPolicies(expanded.policies);
    const blocks = blockPolicies(expanded.policies);
    expect(allows).toHaveLength(2);
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
    expect(allowByDomain['github.com']?.matchers).toEqual([
      { exact: '/foo/bar/info/refs', methods: ['GET'] },
      { exact: '/foo/bar/git-upload-pack', methods: ['POST'] },
      { exact: '/foo/bar/git-receive-pack', methods: ['POST'] },
    ]);
    expect(allowByDomain['codeload.github.com']?.matchers).toEqual([
      { prefix: '/foo/bar', methods: ['GET'] },
    ]);
    expect(allowByDomain['api.github.com']).toBeUndefined();
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

  it('expands multiple repos into per-repo allow policies plus catch-all blocks and one credentials write', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'a/b' }, { name: 'c/d' }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    // 2 repos × 2 allow policies (github.com + codeload) = 4; +3 blocks = 7.
    expect(expanded.policies).toHaveLength(7);
    expect(allowPolicies(expanded.policies)).toHaveLength(4);
    expect(blockPolicies(expanded.policies)).toHaveLength(3);
    const allowIds = allowPolicies(expanded.policies)
      .map((p) => p.id)
      .sort();
    expect(allowIds).toEqual([
      'github:a/b:codeload.github.com',
      'github:a/b:github.com',
      'github:c/d:codeload.github.com',
      'github:c/d:github.com',
    ]);
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
      tokenSource: 'env:GITHUB_TOKEN_1',
    };
    const i2: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN_2',
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
      tokenSource: 'env:GITHUB_TOKEN',
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
      tokenSource: 'env:GITHUB_TOKEN',
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
      tokenSource: 'env:GITHUB_TOKEN',
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

describe('expandPlugins — github readOnly', () => {
  it('drops git-receive-pack from the github.com matchers when readOnly is true', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar', readOnly: true }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    const githubCom = allowPolicies(expanded.policies).find(
      (p) => p.domain === 'github.com',
    );
    if (!githubCom) throw new Error('expected github.com policy');
    expect(githubCom.matchers).toEqual([
      { exact: '/foo/bar/info/refs', methods: ['GET'] },
      { exact: '/foo/bar/git-upload-pack', methods: ['POST'] },
    ]);
    // Codeload policy is unchanged — it's GET-only regardless.
    const codeload = allowPolicies(expanded.policies).find(
      (p) => p.domain === 'codeload.github.com',
    );
    expect(codeload?.matchers).toEqual([
      { prefix: '/foo/bar', methods: ['GET'] },
    ]);
  });

  it('keeps git-receive-pack when readOnly is false (the default)', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar', readOnly: false }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);
    const githubCom = allowPolicies(expanded.policies).find(
      (p) => p.domain === 'github.com',
    );
    expect(githubCom?.matchers).toContainEqual({
      exact: '/foo/bar/git-receive-pack',
      methods: ['POST'],
    });
  });
});

describe('expandPlugins — github api', () => {
  it('emits a broad api.github.com allow policy when api is true', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN',
      api: true,
    };
    const expanded = expandPlugins([plugin], ctx);

    const allows = allowPolicies(expanded.policies);
    // 2 per-repo (github.com + codeload) + 1 api.github.com bypass = 3.
    expect(allows).toHaveLength(3);
    const apiPolicy = allows.find((p) => p.domain === 'api.github.com');
    if (!apiPolicy) throw new Error('expected api.github.com allow policy');
    expect(apiPolicy.id).toBe('github:api:api.github.com');
    // No matchers — broad allow covers /graphql and every REST path.
    expect(apiPolicy.matchers).toBeUndefined();
    if (apiPolicy.action.type !== 'allow') throw new Error('expected allow');
    expect(apiPolicy.action.mutations).toHaveLength(2);
    // The api.github.com block is still emitted but is shadowed by the allow.
    const blocks = blockPolicies(expanded.policies);
    expect(blocks.map((p) => p.id).sort()).toEqual([
      'github:block:api.github.com',
      'github:block:codeload.github.com',
      'github:block:github.com',
    ]);
    // First-match-wins: the api allow precedes the api block.
    const apiAllowIdx = expanded.policies.indexOf(apiPolicy);
    const apiBlockIdx = expanded.policies.findIndex(
      (p) => p.id === 'github:block:api.github.com',
    );
    expect(apiAllowIdx).toBeLessThan(apiBlockIdx);
  });

  it('omits the api.github.com allow when api is false (the default)', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);
    const apiAllow = allowPolicies(expanded.policies).find(
      (p) => p.domain === 'api.github.com',
    );
    expect(apiAllow).toBeUndefined();
  });
});

describe('expandPlugins — claude-code', () => {
  it('emits installer + api domains, the apiKeyHelper settings file, and an x-api-key substitution policy + Authorization strip in api-key mode', () => {
    const plugin: Plugin = { type: 'claude-code', authMode: 'api-key' };
    const expanded = expandPlugins([plugin], ctx);

    expect(new Set(expanded.domains)).toEqual(
      new Set(['claude.ai', 'downloads.claude.ai', 'api.anthropic.com']),
    );

    // Single allow policy targeting api.anthropic.com — no block / no
    // matchers (the bare host allowlist is the outer gate).
    expect(expanded.policies).toHaveLength(1);
    const policy = expanded.policies[0];
    if (!policy) throw new Error('expected one policy');
    expect(policy.id).toBe('claude-code:api');
    expect(policy.domain).toBe('api.anthropic.com');
    expect(policy.matchers).toBeUndefined();
    if (policy.action.type !== 'allow') throw new Error('expected allow');
    const muts = policy.action.mutations ?? [];
    // Two mutations: substitute into x-api-key, strip Authorization (which
    // apiKeyHelper otherwise also fills with the same placeholder).
    expect(muts).toHaveLength(2);
    const replace = muts[0];
    if (replace?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation first');
    }
    expect(replace.header).toBe('x-api-key');
    expect(replace.from).toMatch(PLACEHOLDER_RE);
    expect(replace.to).toBe('env:ANTHROPIC_API_KEY');
    expect(replace.transform).toBeUndefined();
    expect(muts[1]).toEqual({ kind: 'remove-header', header: 'Authorization' });

    // The settings.json command embeds the same placeholder in apiKeyHelper
    // and disables auto-update + telemetry.
    expect(expanded.commands).toHaveLength(1);
    const cmd = expanded.commands[0];
    if (!cmd) throw new Error('expected one command');
    expect(cmd.user).toBe('default');
    expect(cmd.argv[0]).toBe('sh');
    expect(cmd.argv[2]).toMatch(/\$HOME\/\.claude\/settings\.json/);
    const body = cmd.argv[4] ?? '';
    const parsed = JSON.parse(body) as {
      apiKeyHelper: string;
      env: Record<string, string>;
    };
    expect(parsed.apiKeyHelper).toBe(`/bin/echo ${replace.from}`);
    expect(parsed.env).toEqual({
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    });

    // Bootstrap installs Claude Code via the documented one-liner.
    expect(expanded.bootstrapScript).toMatch(
      /sudo -iu sandbox bash -lc 'curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash'/,
    );
  });

  it('substitutes into Authorization and strips x-api-key in oauth-token mode', () => {
    const plugin: Plugin = { type: 'claude-code', authMode: 'oauth-token' };
    const expanded = expandPlugins([plugin], ctx);

    const policy = expanded.policies[0];
    if (policy?.action.type !== 'allow') {
      throw new Error('expected allow policy');
    }
    const muts = policy.action.mutations ?? [];
    expect(muts).toHaveLength(2);
    const replace = muts[0];
    if (replace?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation first');
    }
    expect(replace.header).toBe('Authorization');
    expect(replace.to).toBe('env:CLAUDE_CODE_OAUTH_TOKEN');
    expect(muts[1]).toEqual({ kind: 'remove-header', header: 'x-api-key' });
  });

  it('honours an explicit tokenSource override', () => {
    const plugin: Plugin = {
      type: 'claude-code',
      authMode: 'api-key',
      tokenSource: 'env:MY_CUSTOM_KEY',
    };
    const expanded = expandPlugins([plugin], ctx);

    const policy = expanded.policies[0];
    if (policy?.action.type !== 'allow') {
      throw new Error('expected allow policy');
    }
    const mut = policy.action.mutations?.[0];
    if (mut?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation');
    }
    expect(mut.to).toBe('env:MY_CUSTOM_KEY');
  });

  it('does not allowlist OAuth-flow or telemetry hosts', () => {
    const expanded = expandPlugins(
      [{ type: 'claude-code', authMode: 'oauth-token' }],
      ctx,
    );
    // Login-flow hosts must stay out so a sandbox can't run /login on its
    // own — auth is always a host operation. Telemetry stays out so
    // DISABLE_TELEMETRY is the load-bearing setting, not the allowlist.
    expect(expanded.domains).not.toContain('console.anthropic.com');
    expect(expanded.domains).not.toContain('statsig.anthropic.com');
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
