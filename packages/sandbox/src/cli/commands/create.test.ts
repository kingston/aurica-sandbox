import { describe, expect, it } from 'vitest';

import { githubPluginFromGitConfig, nonGithubGitAction } from './create.js';

describe('githubPluginFromGitConfig', () => {
  it('builds a synthetic github plugin for a github URL with tokenSource', () => {
    const plugin = githubPluginFromGitConfig({
      url: 'https://github.com/kingston/aurica-sandbox',
      tokenSource: 'env:GITHUB_TOKEN',
    });
    expect(plugin).toEqual({
      type: 'github',
      repositories: [{ name: 'kingston/aurica-sandbox' }],
      token: 'env:GITHUB_TOKEN',
    });
  });

  it('strips the .git suffix when present', () => {
    const plugin = githubPluginFromGitConfig({
      url: 'https://github.com/foo/bar.git',
      tokenSource: 'env:GITHUB_TOKEN',
    });
    expect(plugin?.repositories[0]?.name).toBe('foo/bar');
  });

  it('returns null for non-github hosts', () => {
    expect(
      githubPluginFromGitConfig({
        url: 'https://gitlab.com/foo/bar',
        tokenSource: 'env:GITLAB_TOKEN',
      }),
    ).toBeNull();
  });

  it('returns null when tokenSource is absent (public repo)', () => {
    expect(
      githubPluginFromGitConfig({
        url: 'https://github.com/foo/bar',
      }),
    ).toBeNull();
  });

  it('returns null when the URL has fewer than two path segments', () => {
    expect(
      githubPluginFromGitConfig({
        url: 'https://github.com/foo',
        tokenSource: 'env:T',
      }),
    ).toBeNull();
  });
});

describe('nonGithubGitAction', () => {
  it('returns a host-level Authorization action for non-github URLs', () => {
    const action = nonGithubGitAction({
      url: 'https://gitlab.com/foo/bar',
      tokenSource: 'env:GITLAB_TOKEN',
    });
    expect(action).toEqual({
      domain: 'gitlab.com',
      hook: 'replaceApiKey',
      header: 'Authorization',
      placeholderValue: '__AURICA_GIT_TOKEN__',
      replacementValue: 'env:GITLAB_TOKEN',
    });
  });

  it('returns null for github URLs (handled by plugin path)', () => {
    expect(
      nonGithubGitAction({
        url: 'https://github.com/foo/bar',
        tokenSource: 'env:GITHUB_TOKEN',
      }),
    ).toBeNull();
  });

  it('returns null when tokenSource is absent', () => {
    expect(
      nonGithubGitAction({ url: 'https://gitlab.com/foo/bar' }),
    ).toBeNull();
  });
});
