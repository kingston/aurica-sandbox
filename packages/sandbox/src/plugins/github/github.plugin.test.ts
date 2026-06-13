import { describe, expect, it, vi } from 'vitest';

import type { ProxyPolicy } from '#src/config/index.js';

import {
  expandPlugins,
  type ProjectPlugins,
  type UserPlugins,
} from '../index.js';

// Stub the host `~/.gitconfig` read so create-time identity resolution is
// deterministic — tests that exercise the host fallback override it per-case.
vi.mock('./host-identity.js', () => ({
  readHostGitIdentity: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
}));

import { readHostGitIdentity } from './host-identity.js';

const readIdentityMock = vi.mocked(readHostGitIdentity);

const PLACEHOLDER_RE = /^__AURICA_TOKEN_[0-9A-F]{16}__$/;

const ctx = {
  linuxUser: 'sandbox',
  sandboxName: 'sb-test',
  authSecret: 'test-secret',
};
const emptyUser: UserPlugins = {};

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

function allowPolicies(policies: readonly ProxyPolicy[]): ProxyPolicy[] {
  return policies.filter((p) => p.action.type === 'allow');
}

function blockPolicies(policies: readonly ProxyPolicy[]): ProxyPolicy[] {
  return policies.filter((p) => p.action.type === 'block');
}

describe('githubPlugin', () => {
  it('emits domains, default fetch+push policies, and commands for one github plugin', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

    expect(new Set(expanded.domains)).toEqual(
      new Set(['*.githubusercontent.com', 'cli.github.com']),
    );
    expect(expanded.policies).toHaveLength(3);
    const allows = allowPolicies(expanded.policies);
    const blocks = blockPolicies(expanded.policies);
    expect(allows).toHaveLength(3);
    expect(blocks).toHaveLength(0);
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
    expect(expanded.bootstrapScript).toMatch(
      /cat > \/usr\/local\/bin\/aurica-git-credential/,
    );
    expect(expanded.bootstrapScript).toMatch(
      /git credential-store --file "\$HOME\/\.git-credentials" get/,
    );
    expect(expanded.bootstrapScript).toMatch(/store\|erase\) exit 0/);
  });

  it('expands multiple repos into per-repo allow policies and one credentials write', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'a/b' }, { name: 'c/d' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

    expect(expanded.policies).toHaveLength(5);
    expect(allowPolicies(expanded.policies)).toHaveLength(5);
    expect(blockPolicies(expanded.policies)).toHaveLength(0);
    const allowIds = allowPolicies(expanded.policies)
      .map((p) => p.id)
      .sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    expect(allowIds).toEqual([
      'github:a/b:codeload.github.com',
      'github:a/b:github.com',
      'github:api:passthrough:api.github.com',
      'github:c/d:codeload.github.com',
      'github:c/d:github.com',
    ]);
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

  it('mirrors project.user into the VM as `git config --global user.{name,email}`', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        user: { name: 'Ada Lovelace', email: 'ada@example.com' },
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

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

  it('falls back to user-level defaultUser when project omits user', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const user: UserPlugins = {
      github: {
        defaultUser: { name: 'Grace Hopper', email: 'grace@example.com' },
      },
    };
    const expanded = await expandPlugins(project, user, ctx);
    const nameCmd = expanded.commands.find((c) => c.argv.includes('user.name'));
    expect(nameCmd?.argv).toContain('Grace Hopper');
  });

  it('emits no user-identity commands when neither layer provides user', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);
    const argvs = expanded.commands.map((c) => c.argv);
    expect(
      argvs.some(
        (argv) => argv.includes('user.name') || argv.includes('user.email'),
      ),
    ).toBe(false);
  });

  it('falls back to the host ~/.gitconfig at create time when both layers omit user', async () => {
    readIdentityMock.mockResolvedValueOnce({
      name: 'Linus Torvalds',
      email: 'linus@example.com',
    });
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);
    const nameCmd = expanded.commands.find((c) => c.argv.includes('user.name'));
    expect(nameCmd?.argv).toContain('Linus Torvalds');
  });

  it('emits no block policies — unmatched paths fall through to the host allowlist', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);
    expect(blockPolicies(expanded.policies)).toHaveLength(0);
  });

  it('derives a unique placeholder per sandbox (authSecret-scoped)', async () => {
    const plugins: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const a = await expandPlugins(plugins, emptyUser, {
      ...ctx,
      authSecret: 'secret-a',
    });
    const b = await expandPlugins(plugins, emptyUser, {
      ...ctx,
      authSecret: 'secret-b',
    });
    const aFirst = allowPolicies(a.policies).find(
      (p) => p.id !== 'github:api:passthrough:api.github.com',
    );
    const bFirst = allowPolicies(b.policies).find(
      (p) => p.id !== 'github:api:passthrough:api.github.com',
    );
    if (!aFirst || !bFirst) throw new Error('expected allow policies');
    expect(placeholderOf(aFirst)).not.toBe(placeholderOf(bFirst));
  });

  it('derives the same placeholder across calls for the same sandbox', async () => {
    const plugins: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const a = await expandPlugins(plugins, emptyUser, ctx);
    const b = await expandPlugins(plugins, emptyUser, ctx);
    const aFirst = allowPolicies(a.policies).find(
      (p) => p.id !== 'github:api:passthrough:api.github.com',
    );
    const bFirst = allowPolicies(b.policies).find(
      (p) => p.id !== 'github:api:passthrough:api.github.com',
    );
    if (!aFirst || !bFirst) throw new Error('expected allow policies');
    expect(placeholderOf(aFirst)).toBe(placeholderOf(bFirst));
  });
});

describe('githubPlugin — readOnly', () => {
  it('drops git-receive-pack from the github.com matchers when readOnly is true', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar', readOnly: true }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

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
    const codeload = allowPolicies(expanded.policies).find(
      (p) => p.domain === 'codeload.github.com',
    );
    expect(codeload?.matchers).toEqual([
      { prefix: '/foo/bar', methods: ['GET'] },
    ]);
  });

  it('keeps git-receive-pack when readOnly is false (the default)', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar', readOnly: false }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);
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

describe('githubPlugin — api mode', () => {
  it('emits a broad api.github.com allow policy when api is true', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
        api: true,
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

    const allows = allowPolicies(expanded.policies);
    expect(allows).toHaveLength(3);
    const apiPolicy = allows.find((p) => p.domain === 'api.github.com');
    if (!apiPolicy) throw new Error('expected api.github.com allow policy');
    expect(apiPolicy.id).toBe('github:api:api.github.com');
    expect(apiPolicy.matchers).toBeUndefined();
    if (apiPolicy.action.type !== 'allow') throw new Error('expected allow');
    expect(apiPolicy.action.mutations).toHaveLength(2);
    expect(blockPolicies(expanded.policies)).toHaveLength(0);

    const hostsYamlCmd = expanded.commands.find((c) =>
      c.argv.some(
        (s) => typeof s === 'string' && s.includes('.config/gh/hosts.yml'),
      ),
    );
    expect(hostsYamlCmd).toBeDefined();
    expect(hostsYamlCmd?.argv).toContain('github.com:');
  });

  it('emits an unauthenticated api.github.com passthrough when api is false (the default)', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);
    const apiAllow = allowPolicies(expanded.policies).find(
      (p) => p.domain === 'api.github.com',
    );
    if (!apiAllow) throw new Error('expected api.github.com passthrough');
    expect(apiAllow.id).toBe('github:api:passthrough:api.github.com');
    expect(apiAllow.matchers).toBeUndefined();
    expect(apiAllow.action).toEqual({ type: 'allow' });
  });

  it('does NOT write ~/.config/gh/hosts.yml when api is false (the default)', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);
    const hostsYamlCmd = expanded.commands.find((c) =>
      c.argv.some(
        (s) => typeof s === 'string' && s.includes('.config/gh/hosts.yml'),
      ),
    );
    expect(hostsYamlCmd).toBeUndefined();
  });
});

describe('githubPlugin — user-config fallback', () => {
  it('uses user-level defaultTokenSource when project omits tokenSource', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'a/b' }],
      },
    };
    const user: UserPlugins = {
      github: { defaultTokenSource: 'env:USER_TOKEN' },
    };
    const expanded = await expandPlugins(project, user, ctx);
    const allowed = allowPolicies(expanded.policies).find(
      (p) => p.id !== 'github:api:passthrough:api.github.com',
    );
    if (allowed?.action.type !== 'allow') {
      throw new Error('expected allow policy');
    }
    const mut = allowed.action.mutations?.[0];
    if (mut?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation');
    }
    expect(mut.to).toBe('env:USER_TOKEN');
  });

  it('uses user-level defaultUsername when project omits username', async () => {
    const project: ProjectPlugins = {
      github: {
        repositories: [{ name: 'a/b' }],
        tokenSource: 'env:GH_TOKEN',
      },
    };
    const user: UserPlugins = {
      github: { defaultUsername: 'x-access-token' },
    };
    const expanded = await expandPlugins(project, user, ctx);
    const credsCmd = expanded.commands.find((c) =>
      c.argv.some((a) => a.includes('.git-credentials')),
    );
    expect(
      credsCmd?.argv.some((a) => a.startsWith('https://x-access-token:')),
    ).toBe(true);
  });

  it('project overrides user-level defaults', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'project-user',
        repositories: [{ name: 'a/b' }],
        tokenSource: 'env:PROJECT_TOKEN',
      },
    };
    const user: UserPlugins = {
      github: {
        defaultUsername: 'user-default',
        defaultTokenSource: 'env:USER_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, user, ctx);
    const allowed = allowPolicies(expanded.policies).find(
      (p) => p.id !== 'github:api:passthrough:api.github.com',
    );
    if (allowed?.action.type !== 'allow') {
      throw new Error('expected allow policy');
    }
    const mut = allowed.action.mutations?.[0];
    if (mut?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation');
    }
    expect(mut.to).toBe('env:PROJECT_TOKEN');
  });

  it('throws when neither project nor user provides tokenSource', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'a/b' }],
      },
    };
    await expect(expandPlugins(project, emptyUser, ctx)).rejects.toThrow(
      /tokenSource/,
    );
  });

  it('throws when neither project nor user provides username', async () => {
    const project: ProjectPlugins = {
      github: {
        repositories: [{ name: 'a/b' }],
        tokenSource: 'env:GH_TOKEN',
      },
    };
    await expect(expandPlugins(project, emptyUser, ctx)).rejects.toThrow(
      /username/,
    );
  });

  it('user-level github defaults do NOT activate the plugin when the project omits it', async () => {
    const project: ProjectPlugins = {};
    const user: UserPlugins = {
      github: { defaultTokenSource: 'env:USER_TOKEN' },
    };
    const expanded = await expandPlugins(project, user, ctx);
    expect(expanded.domains).toEqual([]);
    expect(expanded.policies).toEqual([]);
    expect(expanded.commands).toEqual([]);
  });
});

describe('githubPlugin — checkout / projectInitCwdOverride', () => {
  it('clones every listed repo to /workspaces/<repo>, writes AURICA_PROJECT_DIR to /etc/environment, and sets projectInitCwdOverride to the first repo', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

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

  it('clones all repositories in order and picks the first entry as the primary', async () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [
          { name: 'a/primary' },
          { name: 'a/secondary' },
          { name: 'a/tertiary' },
        ],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

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
});
