import { describe, expect, it } from 'vitest';

import type { ProxyPolicy } from '#src/config/index.js';

import { expandPlugins } from '../index.js';
import type { Plugin } from '../schema.js';

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

describe('expandPlugins — github', () => {
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
    // 2 per-repo allow (github.com + codeload.github.com) + 1
    // unauthenticated api.github.com passthrough. No catch-all blocks —
    // unmatched requests fall through to the host allowlist, and
    // `credential.useHttpPath = true` keeps the placeholder from ever
    // accompanying a request outside the configured repo paths.
    expect(expanded.policies).toHaveLength(3);
    const allows = allowPolicies(expanded.policies);
    const blocks = blockPolicies(expanded.policies);
    expect(allows).toHaveLength(3);
    expect(blocks).toHaveLength(0);
    // The api.github.com passthrough has no mutations — drop it before
    // pulling the placeholder.
    const repoAllows = allows.filter(
      (p) => p.id !== 'github:api:passthrough:api.github.com',
    );
    const placeholders = new Set(repoAllows.map(placeholderOf));
    expect(placeholders.size).toBe(1);
    const firstAllow = repoAllows[0];
    if (!firstAllow) throw new Error('expected at least one repo allow policy');
    const placeholder = placeholderOf(firstAllow);
    expect(placeholder).toMatch(PLACEHOLDER_RE);

    const allowByDomain: Record<string, ProxyPolicy> = Object.fromEntries(
      allows.map((p) => [p.domain, p]),
    );
    expect(allowByDomain['github.com']?.matchers).toEqual([
      { exact: '/foo/bar/info/refs', methods: ['GET'] },
      { exact: '/foo/bar.git/info/refs', methods: ['GET'] },
      { exact: '/foo/bar/git-upload-pack', methods: ['POST'] },
      { exact: '/foo/bar.git/git-upload-pack', methods: ['POST'] },
      { exact: '/foo/bar/git-receive-pack', methods: ['POST'] },
      { exact: '/foo/bar.git/git-receive-pack', methods: ['POST'] },
    ]);
    expect(allowByDomain['codeload.github.com']?.matchers).toEqual([
      { prefix: '/foo/bar', methods: ['GET'] },
    ]);
    // api.github.com is now an unauthenticated passthrough when `api` is
    // false — no token mutations, no path matchers.
    const apiPassthrough = allowByDomain['api.github.com'];
    if (!apiPassthrough) {
      throw new Error('expected api.github.com passthrough policy');
    }
    expect(apiPassthrough.id).toBe('github:api:passthrough:api.github.com');
    expect(apiPassthrough.matchers).toBeUndefined();
    expect(apiPassthrough.action).toEqual({ type: 'allow' });

    for (const policy of repoAllows) {
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
    // helper(1) + useHttpPath(2) + git-credentials(3) + clone(4) +
    // /etc/environment(5) — 5 commands for a single repo with no
    // plugin.user. hosts.yml is omitted because `api` defaults to false:
    // writing the placeholder there would leak it to GitHub since the
    // api.github.com passthrough policy carries no token mutations.
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
          `https://x-access-token:${placeholder}@github.com/foo/bar.git`,
        ],
      },
      {
        user: 'default',
        argv: [
          'sh',
          '-c',
          'test -d "$2/.git" || git clone "$1" "$2"',
          'sh',
          'https://github.com/foo/bar.git',
          '/workspaces/bar',
        ],
      },
      {
        user: 'root',
        argv: [
          'sh',
          '-c',
          String.raw`sed -i "/^AURICA_PROJECT_DIR=/d" /etc/environment && printf "AURICA_PROJECT_DIR=%s\n" "$1" >> /etc/environment`,
          'sh',
          '/workspaces/bar',
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

  it('expands multiple repos into per-repo allow policies and one credentials write', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'a/b' }, { name: 'c/d' }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    // 2 repos × 2 allow policies (github.com + codeload) = 4; +1
    // api.github.com passthrough = 5. No block policies — see the
    // single-repo test for rationale.
    expect(expanded.policies).toHaveLength(5);
    expect(allowPolicies(expanded.policies)).toHaveLength(5);
    expect(blockPolicies(expanded.policies)).toHaveLength(0);
    const allowIds = allowPolicies(expanded.policies)
      .map((p) => p.id)
      .sort();
    expect(allowIds).toEqual([
      'github:a/b:codeload.github.com',
      'github:a/b:github.com',
      'github:api:passthrough:api.github.com',
      'github:c/d:codeload.github.com',
      'github:c/d:github.com',
    ]);
    // helper(1) + useHttpPath(2) + creds(3) + 2 clones +
    // /etc/environment(6) = 6 commands for two repos with no plugin.user.
    // hosts.yml is omitted because `api` defaults to false.
    expect(expanded.commands).toHaveLength(6);
    const credsWrite = expanded.commands[2];
    expect(credsWrite?.argv[0]).toBe('sh');
    const firstAllow = allowPolicies(expanded.policies).find(
      (p) => p.id !== 'github:api:passthrough:api.github.com',
    );
    if (!firstAllow) throw new Error('expected at least one repo allow policy');
    const placeholder = placeholderOf(firstAllow);
    const urls = credsWrite?.argv.slice(4) ?? [];
    expect(urls).toEqual([
      `https://x-access-token:${placeholder}@github.com/a/b`,
      `https://x-access-token:${placeholder}@github.com/a/b.git`,
      `https://x-access-token:${placeholder}@github.com/c/d`,
      `https://x-access-token:${placeholder}@github.com/c/d.git`,
    ]);
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

    // helper(1) + useHttpPath(2) + creds(3) + user.name(4) + user.email(5)
    // + clone(6) + /etc/environment(7) = 7 commands. hosts.yml omitted
    // because `api` defaults to false.
    expect(expanded.commands).toHaveLength(7);
    const nameCmd = expanded.commands.find((c) => c.argv.includes('user.name'));
    const emailCmd = expanded.commands.find((c) =>
      c.argv.includes('user.email'),
    );
    expect(nameCmd).toEqual({
      user: 'default',
      argv: ['git', 'config', '--global', 'user.name', 'Ada Lovelace'],
    });
    expect(emailCmd).toEqual({
      user: 'default',
      argv: ['git', 'config', '--global', 'user.email', 'ada@example.com'],
    });
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

  it('emits no block policies — unmatched paths fall through to the host allowlist', () => {
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);
    expect(blockPolicies(expanded.policies)).toHaveLength(0);
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
      { exact: '/foo/bar.git/info/refs', methods: ['GET'] },
      { exact: '/foo/bar/git-upload-pack', methods: ['POST'] },
      { exact: '/foo/bar.git/git-upload-pack', methods: ['POST'] },
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
    expect(githubCom?.matchers).toContainEqual({
      exact: '/foo/bar.git/git-receive-pack',
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
    // No block policies — unmatched paths fall through to the host
    // allowlist; placeholder leakage is prevented by
    // `credential.useHttpPath = true`.
    expect(blockPolicies(expanded.policies)).toHaveLength(0);

    // hosts.yml is written so the gh CLI is pre-authenticated. The
    // api.github.com policy carries token mutations, so the placeholder is
    // substituted on the wire.
    const hostsYamlCmd = expanded.commands.find((c) =>
      c.argv.some(
        (s) => typeof s === 'string' && s.includes('.config/gh/hosts.yml'),
      ),
    );
    expect(hostsYamlCmd).toBeDefined();
    expect(hostsYamlCmd?.argv).toContain('github.com:');
  });

  it('emits an unauthenticated api.github.com passthrough when api is false (the default)', () => {
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
    if (!apiAllow) throw new Error('expected api.github.com passthrough');
    expect(apiAllow.id).toBe('github:api:passthrough:api.github.com');
    expect(apiAllow.matchers).toBeUndefined();
    // No token attached — anonymous passthrough only.
    expect(apiAllow.action).toEqual({ type: 'allow' });
  });

  it('does NOT write ~/.config/gh/hosts.yml when api is false (the default)', () => {
    // Without an api.github.com mutation, writing the placeholder into
    // hosts.yml would leak it verbatim on any gh CLI call.
    const plugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      repositories: [{ name: 'foo/bar' }],
      tokenSource: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);
    const hostsYamlCmd = expanded.commands.find((c) =>
      c.argv.some(
        (s) => typeof s === 'string' && s.includes('.config/gh/hosts.yml'),
      ),
    );
    expect(hostsYamlCmd).toBeUndefined();
  });
});
