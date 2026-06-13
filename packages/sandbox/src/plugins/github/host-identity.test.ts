import { describe, expect, it } from 'vitest';

import { parseGithubRepoSlug } from './host-identity.js';

describe('parseGithubRepoSlug', () => {
  it('parses HTTPS remotes with and without a .git suffix', () => {
    expect(parseGithubRepoSlug('https://github.com/acme/widgets.git')).toBe(
      'acme/widgets',
    );
    expect(parseGithubRepoSlug('https://github.com/acme/widgets')).toBe(
      'acme/widgets',
    );
  });

  it('parses SSH and ssh:// remotes', () => {
    expect(parseGithubRepoSlug('git@github.com:acme/widgets.git')).toBe(
      'acme/widgets',
    );
    expect(parseGithubRepoSlug('ssh://git@github.com/acme/widgets.git')).toBe(
      'acme/widgets',
    );
  });

  it('returns null for non-GitHub or unparseable URLs', () => {
    expect(
      parseGithubRepoSlug('https://gitlab.com/acme/widgets.git'),
    ).toBeNull();
    expect(parseGithubRepoSlug('not a url')).toBeNull();
    expect(parseGithubRepoSlug('')).toBeNull();
  });
});
