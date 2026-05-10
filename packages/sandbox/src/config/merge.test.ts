import { describe, expect, it } from 'vitest';

import type { Plugin } from '#src/plugins/schema.js';

import { mergePlugins } from './merge.js';
import type { UserPlugin } from './user.js';

describe('mergePlugins', () => {
  it('passes a project-only plugin through unchanged when no user match', () => {
    const projectPlugin: Plugin = {
      type: 'github',
      username: 'x-access-token',
      tokenSource: 'env:GITHUB_API_KEY',
      repositories: [{ name: 'owner/repo' }],
    };
    const result = mergePlugins([], [projectPlugin]);
    expect(result).toEqual([projectPlugin]);
  });

  it('inherits user-level fields when project omits them', () => {
    const userPlugin: UserPlugin = {
      type: 'github',
      username: 'x-access-token',
      tokenSource: 'env:GITHUB_API_KEY',
      user: { name: 'Ada', email: 'ada@example.com' },
    };
    const projectPlugin = {
      type: 'github' as const,
      repositories: [{ name: 'owner/repo' }],
    };
    const result = mergePlugins([userPlugin], [projectPlugin]);
    expect(result).toEqual([
      {
        type: 'github',
        username: 'x-access-token',
        tokenSource: 'env:GITHUB_API_KEY',
        user: { name: 'Ada', email: 'ada@example.com' },
        repositories: [{ name: 'owner/repo' }],
      },
    ]);
  });

  it('lets the project override a user-level field', () => {
    const userPlugin: UserPlugin = {
      type: 'github',
      tokenSource: 'env:GITHUB_API_KEY',
    };
    const projectPlugin = {
      type: 'github' as const,
      username: 'x-access-token',
      tokenSource: 'env:OTHER_KEY',
      repositories: [{ name: 'owner/repo' }],
    };
    const result = mergePlugins([userPlugin], [projectPlugin]);
    expect(result[0]).toMatchObject({ tokenSource: 'env:OTHER_KEY' });
  });

  it('replaces user repositories entirely when project sets repositories', () => {
    const userPlugin: UserPlugin = {
      type: 'github',
      repositories: [{ name: 'user/inherited' }],
    };
    const projectPlugin = {
      type: 'github' as const,
      username: 'x-access-token',
      tokenSource: 'env:GITHUB_API_KEY',
      repositories: [{ name: 'owner/a' }, { name: 'owner/b' }],
    };
    const result = mergePlugins([userPlugin], [projectPlugin]);
    expect(result[0]).toMatchObject({
      repositories: [{ name: 'owner/a' }, { name: 'owner/b' }],
    });
  });

  it('omits user-level plugin types the project did not opt into', () => {
    const userPlugin: UserPlugin = {
      type: 'github',
      tokenSource: 'env:GITHUB_API_KEY',
    };
    const result = mergePlugins([userPlugin], []);
    expect(result).toEqual([]);
  });

  it('uses the first user-level plugin when multiple of same type exist', () => {
    const userPlugins: UserPlugin[] = [
      { type: 'github', tokenSource: 'env:FIRST' },
      { type: 'github', tokenSource: 'env:SECOND' },
    ];
    const projectPlugin = {
      type: 'github' as const,
      username: 'x-access-token',
      repositories: [{ name: 'owner/repo' }],
    };
    const result = mergePlugins(userPlugins, [projectPlugin]);
    expect(result[0]).toMatchObject({ tokenSource: 'env:FIRST' });
  });
});
