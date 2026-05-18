import { describe, expect, it } from 'vitest';

import type { ProxyPolicy } from '#src/config/index.js';

import { applyPolicies, matchDomain } from './substitution.js';

const resolver = {
  resolve(rawSource: string): Promise<string> {
    return Promise.resolve(`<resolved:${rawSource}>`);
  },
};

const githubPolicy: ProxyPolicy = {
  id: 'gh-test',
  domain: 'api.github.com',
  action: {
    type: 'allow',
    mutations: [
      {
        kind: 'replace-header',
        header: 'Authorization',
        from: 'github-api-key',
        to: 'env:GITHUB_API_KEY',
      },
    ],
  },
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

describe('applyPolicies — replace-header (legacy substitution)', () => {
  it('replaces placeholder when host + header + placeholder match', async () => {
    const headers = { Authorization: 'Bearer github-api-key' };
    const result = await applyPolicies(
      [githubPolicy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(result.outcome).toBe('pass');
    expect(headers.Authorization).toBe('Bearer <resolved:env:GITHUB_API_KEY>');
  });

  it('does not replace when host does not match', async () => {
    const headers = { Authorization: 'Bearer github-api-key' };
    await applyPolicies(
      [githubPolicy],
      'evil.example.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer github-api-key');
  });

  it('does not replace when header is missing', async () => {
    const headers: Record<string, string> = {
      'x-other': 'github-api-key',
    };
    await applyPolicies(
      [githubPolicy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers['x-other']).toBe('github-api-key');
  });

  it('matches header name case-insensitively', async () => {
    const headers = { authorization: 'Bearer github-api-key' };
    await applyPolicies(
      [githubPolicy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers.authorization).toBe('Bearer <resolved:env:GITHUB_API_KEY>');
  });

  it('does not replace when placeholder string is absent', async () => {
    const headers = { Authorization: 'Bearer something-else' };
    await applyPolicies(
      [githubPolicy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer something-else');
  });

  it('cross-domain bleed is impossible', async () => {
    const policy2: ProxyPolicy = {
      id: 'oa-test',
      domain: 'api.openai.com',
      action: {
        type: 'allow',
        mutations: [
          {
            kind: 'replace-header',
            header: 'Authorization',
            from: 'openai-api-key',
            to: 'env:OPENAI_API_KEY',
          },
        ],
      },
    };
    const headers = { Authorization: 'Bearer github-api-key' };
    await applyPolicies(
      [githubPolicy, policy2],
      'api.openai.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer github-api-key');
  });

  it('matches host-only when matchers is omitted', async () => {
    const headers = { Authorization: 'Bearer github-api-key' };
    await applyPolicies(
      [githubPolicy],
      'api.github.com',
      '/anywhere/at/all',
      'GET',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer <resolved:env:GITHUB_API_KEY>');
  });

  it('applies a base64 transform symmetrically to from and resolved to', async () => {
    // Mimic git Basic auth: Authorization: Basic <base64(user:placeholder)>.
    // The proxy should match the encoded blob and substitute the encoded
    // resolved value, with the same `username:` prefix on both sides.
    const username = 'x-access-token';
    const placeholder = 'gh-placeholder';
    const policy: ProxyPolicy = {
      id: 'gh-basic',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [
          {
            kind: 'replace-header',
            header: 'Authorization',
            from: placeholder,
            to: 'env:GITHUB_API_KEY',
            transform: { type: 'base64', prefix: `${username}:` },
          },
        ],
      },
    };
    const sentBlob = Buffer.from(`${username}:${placeholder}`).toString(
      'base64',
    );
    const headers = { Authorization: `Basic ${sentBlob}` };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar',
      'GET',
      headers,
      resolver,
    );
    const expectedBlob = Buffer.from(
      `${username}:<resolved:env:GITHUB_API_KEY>`,
    ).toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expectedBlob}`);
  });

  it('does not match the raw from-string when a transform is set', async () => {
    // Defense check: with a transform configured, the raw `from` string in
    // the header must NOT be substituted — only the transformed form is.
    const policy: ProxyPolicy = {
      id: 'gh-basic',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [
          {
            kind: 'replace-header',
            header: 'Authorization',
            from: 'raw-placeholder',
            to: 'env:GITHUB_API_KEY',
            transform: { type: 'base64', prefix: 'user:' },
          },
        ],
      },
    };
    const headers = { Authorization: 'Bearer raw-placeholder' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer raw-placeholder');
  });
});

function buildAllow(matcherEntries: ProxyPolicy['matchers']): ProxyPolicy {
  return {
    id: 'matcher-test',
    domain: 'api.github.com',
    matchers: matcherEntries,
    action: {
      type: 'allow',
      mutations: [
        {
          kind: 'replace-header',
          header: 'Authorization',
          from: 'p',
          to: 'env:T',
        },
      ],
    },
  };
}

describe('applyPolicies — matchers', () => {
  it('exact matcher matches one path only', async () => {
    const policy = buildAllow([{ exact: '/repos/foo/bar' }]);
    const a = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar',
      'GET',
      a,
      resolver,
    );
    expect(a.Authorization).toBe('Bearer <resolved:env:T>');

    const b = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/issues',
      'GET',
      b,
      resolver,
    );
    expect(b.Authorization).toBe('Bearer p');
  });

  it('prefix matcher uses segment boundaries', async () => {
    const policy = buildAllow([{ prefix: '/repos/foo/bar' }]);

    // Equal path matches.
    const a = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar',
      'GET',
      a,
      resolver,
    );
    expect(a.Authorization).toBe('Bearer <resolved:env:T>');

    // Sub-segment matches.
    const b = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/issues',
      'GET',
      b,
      resolver,
    );
    expect(b.Authorization).toBe('Bearer <resolved:env:T>');

    // Adjacent segment with similar name does NOT match.
    const c = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar-evil/x',
      'GET',
      c,
      resolver,
    );
    expect(c.Authorization).toBe('Bearer p');
  });

  it('regex matcher applies anchored patterns', async () => {
    const policy = buildAllow([
      { regex: '^/repos/foo/bar/actions/workflows(?:/.*)?$' },
    ]);

    const a = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/actions/workflows',
      'GET',
      a,
      resolver,
    );
    expect(a.Authorization).toBe('Bearer <resolved:env:T>');

    const b = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/actions/workflows/123/runs',
      'GET',
      b,
      resolver,
    );
    expect(b.Authorization).toBe('Bearer <resolved:env:T>');

    const c = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/issues',
      'GET',
      c,
      resolver,
    );
    expect(c.Authorization).toBe('Bearer p');
  });

  it('methods filter restricts a matcher entry', async () => {
    const policy = buildAllow([
      { prefix: '/repos/foo/bar', methods: ['POST'] },
    ]);

    const a = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/issues',
      'GET',
      a,
      resolver,
    );
    expect(a.Authorization).toBe('Bearer p');

    const b = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/issues',
      'POST',
      b,
      resolver,
    );
    expect(b.Authorization).toBe('Bearer <resolved:env:T>');
  });

  it('method comparison is case-insensitive', async () => {
    const policy = buildAllow([{ prefix: '/x', methods: ['POST'] }]);
    const headers = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/x',
      'post',
      headers,
      resolver,
    );
    expect(headers.Authorization).toBe('Bearer <resolved:env:T>');
  });

  it('multiple matcher entries OR together', async () => {
    const policy = buildAllow([
      { prefix: '/repos/foo/bar/pulls' },
      { prefix: '/repos/foo/bar/issues' },
    ]);

    const a = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/issues/1',
      'GET',
      a,
      resolver,
    );
    expect(a.Authorization).toBe('Bearer <resolved:env:T>');

    const b = { Authorization: 'Bearer p' };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/contents',
      'GET',
      b,
      resolver,
    );
    expect(b.Authorization).toBe('Bearer p');
  });

  it('passes through unmodified when no policy matches', async () => {
    const policy = buildAllow([{ prefix: '/repos/foo/bar/pulls' }]);
    const headers = { Authorization: 'Bearer p' };
    const result = await applyPolicies(
      [policy],
      'api.github.com',
      '/repos/foo/bar/security',
      'GET',
      headers,
      resolver,
    );
    expect(result.outcome).toBe('pass');
    expect(headers.Authorization).toBe('Bearer p');
  });
});

describe('applyPolicies — first-match-wins and block', () => {
  it('block policy short-circuits before later allow policy fires', async () => {
    const block: ProxyPolicy = {
      id: 'block-secrets',
      domain: 'api.github.com',
      matchers: [{ prefix: '/repos/foo/bar/security' }],
      action: { type: 'block' },
    };
    const allow: ProxyPolicy = {
      id: 'allow-everything',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [
          {
            kind: 'replace-header',
            header: 'Authorization',
            from: 'p',
            to: 'env:T',
          },
        ],
      },
    };
    const headers = { Authorization: 'Bearer p' };
    const result = await applyPolicies(
      [block, allow],
      'api.github.com',
      '/repos/foo/bar/security/secrets',
      'GET',
      headers,
      resolver,
    );
    expect(result).toEqual({
      outcome: 'block',
      headers,
      blockedBy: 'block-secrets',
    });
    // Header was not mutated because block short-circuited.
    expect(headers.Authorization).toBe('Bearer p');
  });

  it('first matching allow wins over later allow', async () => {
    const earlier: ProxyPolicy = {
      id: 'earlier',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [
          {
            kind: 'set-header',
            header: 'X-Tag',
            value: 'first',
          },
        ],
      },
    };
    const later: ProxyPolicy = {
      id: 'later',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [
          {
            kind: 'set-header',
            header: 'X-Tag',
            value: 'second',
          },
        ],
      },
    };
    const headers: Record<string, string | string[] | undefined> = {};
    await applyPolicies(
      [earlier, later],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers['X-Tag']).toBe('<resolved:first>');
  });

  it('returns pass with unmodified headers when no policy matches', async () => {
    const headers = { Authorization: 'Bearer p' };
    const result = await applyPolicies(
      [],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(result.outcome).toBe('pass');
    expect(headers.Authorization).toBe('Bearer p');
  });
});

describe('applyPolicies — set-header / remove-header mutations', () => {
  it('set-header overwrites existing value (resolves credential source)', async () => {
    const policy: ProxyPolicy = {
      id: 'set-test',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [
          {
            kind: 'set-header',
            header: 'X-Sandbox',
            value: 'env:SANDBOX_FLAG',
          },
        ],
      },
    };
    const headers: Record<string, string | string[] | undefined> = {
      'X-Sandbox': 'old',
    };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers['X-Sandbox']).toBe('<resolved:env:SANDBOX_FLAG>');
  });

  it('set-header creates the header when missing', async () => {
    const policy: ProxyPolicy = {
      id: 'set-test',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [{ kind: 'set-header', header: 'X-Sandbox', value: 'lit' }],
      },
    };
    const headers: Record<string, string | string[] | undefined> = {};
    await applyPolicies(
      [policy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers['X-Sandbox']).toBe('<resolved:lit>');
  });

  it('remove-header drops the header (case-insensitive lookup)', async () => {
    const policy: ProxyPolicy = {
      id: 'rm-test',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [{ kind: 'remove-header', header: 'Cookie' }],
      },
    };
    const headers: Record<string, string | string[] | undefined> = {
      cookie: 'sid=abc',
    };
    await applyPolicies(
      [policy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers.cookie).toBeUndefined();
  });

  it('mutations apply in declared order', async () => {
    const policy: ProxyPolicy = {
      id: 'order-test',
      domain: 'api.github.com',
      action: {
        type: 'allow',
        mutations: [
          { kind: 'set-header', header: 'X', value: 'first' },
          { kind: 'set-header', header: 'X', value: 'second' },
        ],
      },
    };
    const headers: Record<string, string | string[] | undefined> = {};
    await applyPolicies(
      [policy],
      'api.github.com',
      '/',
      'GET',
      headers,
      resolver,
    );
    expect(headers.X).toBe('<resolved:second>');
  });
});

describe('applyPolicies — rewrite-url', () => {
  it('returns rewrite outcome with target URL substituted from {path} template', async () => {
    const policy: ProxyPolicy = {
      id: 'mcp:github',
      domain: 'aurica.mcp.internal',
      matchers: [{ prefix: '/github' }],
      action: {
        type: 'rewrite-url',
        target: 'http://127.0.0.1:51310{path}',
      },
    };
    const result = await applyPolicies(
      [policy],
      'aurica.mcp.internal',
      '/github/mcp',
      'POST',
      {},
      resolver,
      '/github/mcp?x=1',
    );
    expect(result.outcome).toBe('rewrite');
    if (result.outcome !== 'rewrite') throw new Error('unreachable');
    expect(result.url).toBe('http://127.0.0.1:51310/github/mcp?x=1');
  });

  it('runs mutations before returning the rewrite outcome', async () => {
    const policy: ProxyPolicy = {
      id: 'rewrite-with-mutation',
      domain: 'rewrite.test',
      action: {
        type: 'rewrite-url',
        target: 'http://127.0.0.1:51310{path}',
        mutations: [
          {
            kind: 'replace-header',
            header: 'Authorization',
            from: '__PLACEHOLDER__',
            to: 'env:UPSTREAM_TOKEN',
          },
        ],
      },
    };
    const headers: Record<string, string | string[] | undefined> = {
      Authorization: 'Bearer __PLACEHOLDER__',
    };
    const result = await applyPolicies(
      [policy],
      'rewrite.test',
      '/upstream',
      'POST',
      headers,
      resolver,
      '/upstream',
    );
    expect(result.outcome).toBe('rewrite');
    expect(headers.Authorization).toBe('Bearer <resolved:env:UPSTREAM_TOKEN>');
  });

  it('falls back to path when pathWithQuery is omitted', async () => {
    const policy: ProxyPolicy = {
      id: 'mcp:linear',
      domain: 'aurica.mcp.internal',
      action: {
        type: 'rewrite-url',
        target: 'http://127.0.0.1:51310{path}',
      },
    };
    const result = await applyPolicies(
      [policy],
      'aurica.mcp.internal',
      '/linear/mcp',
      'POST',
      {},
      resolver,
    );
    expect(result.outcome).toBe('rewrite');
    if (result.outcome !== 'rewrite') throw new Error('unreachable');
    expect(result.url).toBe('http://127.0.0.1:51310/linear/mcp');
  });
});
