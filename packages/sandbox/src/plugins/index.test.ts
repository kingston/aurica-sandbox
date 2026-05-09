import { describe, expect, it } from 'vitest';

import { expandPlugins, pluginDomainsForGitCoverage } from './index.js';
import type { Plugin } from './schema.js';

const PLACEHOLDER_RE = /^__AURICA_TOKEN_[0-9A-F]{16}__$/;

const ctx = { user: 'sandbox' };

describe('expandPlugins', () => {
  it('emits domains, actions, and commands for one github plugin', () => {
    const plugin: Plugin = {
      type: 'github',
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
      ]),
    );
    expect(expanded.actions).toHaveLength(3);
    const placeholders = new Set(
      expanded.actions.map((a) => a.placeholderValue),
    );
    expect(placeholders.size).toBe(1);
    const placeholder = expanded.actions[0]?.placeholderValue ?? '';
    expect(placeholder).toMatch(PLACEHOLDER_RE);

    const byDomain = Object.fromEntries(
      expanded.actions.map((a) => [a.domain, a]),
    );
    expect(byDomain['github.com']?.pathPrefix).toBe('/foo/bar');
    expect(byDomain['api.github.com']?.pathPrefix).toBe('/repos/foo/bar');
    expect(byDomain['codeload.github.com']?.pathPrefix).toBe('/foo/bar');

    expect(expanded.commands).toEqual([
      {
        user: 'default',
        argv: [
          'git',
          'config',
          '--global',
          'http.https://github.com/foo/bar.extraHeader',
          `Authorization: Bearer ${placeholder}`,
        ],
      },
    ]);
    expect(expanded.bootstrapScript).toBe('');
  });

  it('expands multiple repos into N actions per host', () => {
    const plugin: Plugin = {
      type: 'github',
      repositories: [{ name: 'a/b' }, { name: 'c/d' }],
      token: 'env:GITHUB_TOKEN',
    };
    const expanded = expandPlugins([plugin], ctx);

    expect(expanded.actions).toHaveLength(6);
    expect(expanded.commands).toHaveLength(2);
    const headerArgs = expanded.commands.map((c) => c.argv[3]);
    expect(headerArgs).toContain('http.https://github.com/a/b.extraHeader');
    expect(headerArgs).toContain('http.https://github.com/c/d.extraHeader');
  });

  it('derives a unique placeholder per plugin', () => {
    const i1: Plugin = {
      type: 'github',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN_1',
    };
    const i2: Plugin = {
      type: 'github',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN_2',
    };
    const expanded = expandPlugins([i1, i2], ctx);

    const placeholders = new Set(
      expanded.actions.map((a) => a.placeholderValue),
    );
    expect(placeholders.size).toBe(2);
  });

  it('derives the same placeholder across calls for identical plugin config', () => {
    const plugin: Plugin = {
      type: 'github',
      repositories: [{ name: 'foo/bar' }],
      token: 'env:GITHUB_TOKEN',
    };
    const a = expandPlugins([plugin], ctx);
    const b = expandPlugins([plugin], ctx);
    expect(a.actions[0]?.placeholderValue).toBe(b.actions[0]?.placeholderValue);
  });

  it('returns empty result when no plugins are provided', () => {
    const expanded = expandPlugins([], ctx);
    expect(expanded.domains).toEqual([]);
    expect(expanded.actions).toEqual([]);
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
    expect(expanded.actions).toEqual([]);
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

describe('pluginDomainsForGitCoverage', () => {
  it('returns github hosts only for github plugins', () => {
    expect(
      pluginDomainsForGitCoverage({
        type: 'github',
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
