import { describe, expect, it } from 'vitest';

import type { ProxyAction } from '#src/config/index.js';

import { applyActions, matchDomain } from './substitution.js';

const resolver = {
  resolve(rawSource: string): Promise<string> {
    return Promise.resolve(`<resolved:${rawSource}>`);
  },
};

const githubAction: ProxyAction = {
  domain: 'api.github.com',
  hook: 'replaceApiKey',
  header: 'Authorization',
  placeholderValue: 'github-api-key',
  replacementValue: 'env:GITHUB_API_KEY',
};

describe('matchDomain', () => {
  it('matches exact host', () => {
    expect(matchDomain('api.github.com', 'api.github.com')).toBe(true);
    expect(matchDomain('api.github.com', 'github.com')).toBe(false);
  });

  it('matches wildcard subdomain and bare apex', () => {
    expect(matchDomain('*.github.com', 'api.github.com')).toBe(true);
    expect(matchDomain('*.github.com', 'a.b.github.com')).toBe(true);
    expect(matchDomain('*.github.com', 'github.com')).toBe(true);
    expect(matchDomain('*.github.com', 'evilgithub.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchDomain('*.GitHub.com', 'API.GITHUB.COM')).toBe(true);
  });
});

describe('applyActions', () => {
  it('replaces placeholder when (host, header, placeholder) match', async () => {
    const headers = { Authorization: 'Bearer github-api-key' };
    await applyActions(
      [githubAction],
      'api.github.com',
      '/',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer <resolved:env:GITHUB_API_KEY>');
  });

  it('does not replace when host does not match', async () => {
    const headers = { Authorization: 'Bearer github-api-key' };
    await applyActions(
      [githubAction],
      'evil.example.com',
      '/',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer github-api-key');
  });

  it('does not replace when header is missing', async () => {
    const headers: Record<string, string> = {
      'x-other': 'github-api-key',
    };
    await applyActions(
      [githubAction],
      'api.github.com',
      '/',
      headers,
      resolver,
    );
    expect(headers['x-other']).toBe('github-api-key');
  });

  it('matches header name case-insensitively', async () => {
    const headers = { authorization: 'Bearer github-api-key' };
    await applyActions(
      [githubAction],
      'api.github.com',
      '/',
      headers,
      resolver,
    );
    expect(headers.authorization).toBe('Bearer <resolved:env:GITHUB_API_KEY>');
  });

  it('does not replace when placeholder string is absent', async () => {
    const headers = { Authorization: 'Bearer something-else' };
    await applyActions(
      [githubAction],
      'api.github.com',
      '/',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer something-else');
  });

  it('cross-domain bleed is impossible', async () => {
    const action2: ProxyAction = {
      ...githubAction,
      domain: 'api.openai.com',
      placeholderValue: 'openai-api-key',
      replacementValue: 'env:OPENAI_API_KEY',
    };
    const headers = { Authorization: 'Bearer github-api-key' };
    await applyActions(
      [githubAction, action2],
      'api.openai.com',
      '/',
      headers,
      resolver,
    );
    // openai-api-key not present in header, github action's domain doesn't match
    expect(headers.Authorization).toBe('Bearer github-api-key');
  });

  it('respects pathPrefix when set', async () => {
    const action: ProxyAction = {
      ...githubAction,
      pathPrefix: '/repos/foo/bar',
    };
    const headers1 = { Authorization: 'Bearer github-api-key' };
    await applyActions(
      [action],
      'api.github.com',
      '/repos/foo/bar/issues',
      headers1,
      resolver,
    );
    expect(headers1.Authorization).toBe('Bearer <resolved:env:GITHUB_API_KEY>');

    const headers2 = { Authorization: 'Bearer github-api-key' };
    await applyActions(
      [action],
      'api.github.com',
      '/repos/other/repo',
      headers2,
      resolver,
    );
    expect(headers2.Authorization).toBe('Bearer github-api-key');
  });

  it('matches host-only when pathPrefix is unset', async () => {
    const headers = { Authorization: 'Bearer github-api-key' };
    await applyActions(
      [githubAction],
      'api.github.com',
      '/anywhere/at/all',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer <resolved:env:GITHUB_API_KEY>');
  });

  it('applies a base64 transform symmetrically to placeholder and replacement', async () => {
    // Mimic git Basic auth: Authorization: Basic <base64(user:placeholder)>.
    // The proxy should match the encoded blob and substitute the encoded
    // resolved value, with the same `username:` prefix on both sides.
    const username = 'x-access-token';
    const placeholder = 'gh-placeholder';
    const action: ProxyAction = {
      domain: 'api.github.com',
      hook: 'replaceApiKey',
      header: 'Authorization',
      placeholderValue: placeholder,
      replacementValue: 'env:GITHUB_API_KEY',
      transform: { type: 'base64', prefix: `${username}:` },
    };
    const sentBlob = Buffer.from(`${username}:${placeholder}`).toString(
      'base64',
    );
    const headers = { Authorization: `Basic ${sentBlob}` };
    await applyActions(
      [action],
      'api.github.com',
      '/repos/foo/bar',
      headers,
      resolver,
    );
    const expectedBlob = Buffer.from(
      `${username}:<resolved:env:GITHUB_API_KEY>`,
    ).toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expectedBlob}`);
  });

  it('does not match the raw placeholder when a transform is set', async () => {
    // Defense check: with a transform configured, the raw placeholder
    // string in the header must NOT be substituted — only the transformed
    // form is. Otherwise an attacker who guessed the placeholder could
    // exfiltrate the resolved token via a Bearer header.
    const action: ProxyAction = {
      domain: 'api.github.com',
      hook: 'replaceApiKey',
      header: 'Authorization',
      placeholderValue: 'raw-placeholder',
      replacementValue: 'env:GITHUB_API_KEY',
      transform: { type: 'base64', prefix: 'user:' },
    };
    const headers = { Authorization: 'Bearer raw-placeholder' };
    await applyActions([action], 'api.github.com', '/', headers, resolver);
    expect(headers.Authorization).toBe('Bearer raw-placeholder');
  });
});
