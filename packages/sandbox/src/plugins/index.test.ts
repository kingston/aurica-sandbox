import { describe, expect, it } from 'vitest';

import type { ProxyPolicy } from '#src/config/index.js';

import {
  expandPlugins,
  githubDomainsForGitCoverage,
  type ProjectPlugins,
  type UserPlugins,
} from './index.js';

const ctx = { linuxUser: 'sandbox' };
const emptyUser: UserPlugins = {};

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
  it('derives a unique placeholder per plugin config', () => {
    const p1: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN_1',
      },
    };
    const p2: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN_2',
      },
    };
    const a = expandPlugins(p1, emptyUser, ctx);
    const b = expandPlugins(p2, emptyUser, ctx);
    const aFirst = allowPolicies(a.policies)[0];
    const bFirst = allowPolicies(b.policies)[0];
    if (!aFirst || !bFirst) throw new Error('expected allow policies');
    expect(placeholderOf(aFirst)).not.toBe(placeholderOf(bFirst));
  });

  it('derives the same placeholder across calls for identical plugin config', () => {
    const plugins: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const a = expandPlugins(plugins, emptyUser, ctx);
    const b = expandPlugins(plugins, emptyUser, ctx);
    const aFirst = allowPolicies(a.policies)[0];
    const bFirst = allowPolicies(b.policies)[0];
    if (!aFirst || !bFirst) throw new Error('expected allow policies');
    expect(placeholderOf(aFirst)).toBe(placeholderOf(bFirst));
  });

  it('returns empty result when no plugins are opted into', () => {
    const expanded = expandPlugins({}, emptyUser, ctx);
    expect(expanded.domains).toEqual([]);
    expect(expanded.policies).toEqual([]);
    expect(expanded.commands).toEqual([]);
    expect(expanded.bootstrapScript).toBe('');
  });

  it('concatenates bootstrap snippets in registry order regardless of config-file key order', () => {
    // The registry orders github -> docker -> mise -> claude-code -> cursor;
    // expansion follows that order even if the project config lists keys in
    // a different sequence.
    const expanded = expandPlugins({ mise: {}, docker: {} }, emptyUser, ctx);
    const dockerIdx = expanded.bootstrapScript.indexOf('docker plugin');
    const miseIdx = expanded.bootstrapScript.indexOf('mise plugin');
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(miseIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeLessThan(miseIdx);
  });

  it('docker plugin contributes the apt repo and Docker Hub domains', () => {
    const expanded = expandPlugins({ docker: {} }, emptyUser, ctx);
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
    const expanded = expandPlugins({ mise: {} }, emptyUser, ctx);
    expect(expanded.domains).toEqual(
      expect.arrayContaining([
        'mise.en.dev',
        'mise.jdx.dev',
        'nodejs.org',
        'pypi.org',
      ]),
    );
    expect(expanded.bootstrapScript).toMatch(/mise.en.dev\/gpg-key\.pub/);
    expect(expanded.bootstrapScript).toMatch(
      /apt-get install -y --no-install-recommends mise/,
    );
    expect(expanded.bootstrapScript).toMatch(/mise activate bash/);
    expect(expanded.bootstrapScript).toMatch(/mise activate zsh/);
    expect(expanded.bootstrapScript).toMatch(/mise activate fish/);
    expect(expanded.bootstrapScript).toMatch(/grep -qxF/);
  });

  it('rejects unsafe usernames at expansion time', () => {
    expect(() =>
      expandPlugins({ docker: {} }, emptyUser, { linuxUser: 'bad; rm -rf /' }),
    ).toThrow(/linuxUser/);
    expect(() =>
      expandPlugins({ mise: {} }, emptyUser, { linuxUser: '$(whoami)' }),
    ).toThrow(/linuxUser/);
  });
});

describe('expandPlugins — github user-config fallback', () => {
  it('uses user-level defaultTokenSource when project omits tokenSource', () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'a/b' }],
      },
    };
    const user: UserPlugins = {
      github: { defaultTokenSource: 'env:USER_TOKEN' },
    };
    const expanded = expandPlugins(project, user, ctx);
    const allowed = allowPolicies(expanded.policies)[0];
    if (allowed?.action.type !== 'allow') {
      throw new Error('expected allow policy');
    }
    const mut = allowed.action.mutations?.[0];
    if (mut?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation');
    }
    expect(mut.to).toBe('env:USER_TOKEN');
  });

  it('uses user-level defaultUsername when project omits username', () => {
    const project: ProjectPlugins = {
      github: {
        repositories: [{ name: 'a/b' }],
        tokenSource: 'env:GH_TOKEN',
      },
    };
    const user: UserPlugins = {
      github: { defaultUsername: 'x-access-token' },
    };
    const expanded = expandPlugins(project, user, ctx);
    // The credential URL embeds the resolved username, so writing the
    // credentials file is a clean place to assert it.
    const credsCmd = expanded.commands.find((c) =>
      c.argv.some((a) => a.includes('.git-credentials')),
    );
    expect(
      credsCmd?.argv.some((a) => a.startsWith('https://x-access-token:')),
    ).toBe(true);
  });

  it('project overrides user-level default', () => {
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
    const expanded = expandPlugins(project, user, ctx);
    const allowed = allowPolicies(expanded.policies)[0];
    if (allowed?.action.type !== 'allow') {
      throw new Error('expected allow policy');
    }
    const mut = allowed.action.mutations?.[0];
    if (mut?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation');
    }
    expect(mut.to).toBe('env:PROJECT_TOKEN');
  });

  it('throws when neither project nor user provides tokenSource', () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'a/b' }],
      },
    };
    expect(() => expandPlugins(project, emptyUser, ctx)).toThrow(/tokenSource/);
  });

  it('throws when neither project nor user provides username', () => {
    const project: ProjectPlugins = {
      github: {
        repositories: [{ name: 'a/b' }],
        tokenSource: 'env:GH_TOKEN',
      },
    };
    expect(() => expandPlugins(project, emptyUser, ctx)).toThrow(/username/);
  });

  it('user-level github defaults do NOT activate the plugin when the project omits it', () => {
    const project: ProjectPlugins = {};
    const user: UserPlugins = {
      github: { defaultTokenSource: 'env:USER_TOKEN' },
    };
    const expanded = expandPlugins(project, user, ctx);
    expect(expanded.domains).toEqual([]);
    expect(expanded.policies).toEqual([]);
    expect(expanded.commands).toEqual([]);
  });
});

describe('expandPlugins — github checkout / projectInitCwdOverride', () => {
  it('clones every listed repo to /workspaces/<repo>, writes AURICA_PROJECT_DIR to /etc/environment, and sets projectInitCwdOverride to the first repo', () => {
    const project: ProjectPlugins = {
      github: {
        username: 'x-access-token',
        repositories: [{ name: 'foo/bar' }],
        tokenSource: 'env:GITHUB_TOKEN',
      },
    };
    const expanded = expandPlugins(project, emptyUser, ctx);

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
    const expanded = expandPlugins(project, emptyUser, ctx);

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
