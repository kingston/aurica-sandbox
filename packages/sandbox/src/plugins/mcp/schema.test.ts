import { describe, expect, it } from 'vitest';

import {
  mcpProjectConfigSchema,
  mcpUserConfigSchema,
  mergeUpstreamCatalogs,
  normalizeServerEntries,
  normalizeUpstream,
} from './schema.js';

describe('mcpProjectConfigSchema', () => {
  it('accepts the empty default', () => {
    const parsed = mcpProjectConfigSchema.parse({});
    expect(parsed.servers).toEqual([]);
  });

  it('accepts a list of valid kebab-case server names', () => {
    const parsed = mcpProjectConfigSchema.parse({
      servers: ['github', 'linear', 'sentry-mcp', 'svc1'],
    });
    expect(parsed.servers).toEqual(['github', 'linear', 'sentry-mcp', 'svc1']);
  });

  it('accepts object-form entries with policies', () => {
    const parsed = mcpProjectConfigSchema.parse({
      servers: [
        {
          name: 'github',
          policies: [
            {
              tools: ['pull_request_read'],
              arguments: { repo: 'widgets', owner: 'acme' },
              action: { type: 'allow' },
            },
          ],
          defaultAction: { type: 'block' },
        },
        'linear',
      ],
    });
    expect(parsed.servers).toEqual([
      {
        name: 'github',
        policies: [
          {
            tools: ['pull_request_read'],
            arguments: { repo: 'widgets', owner: 'acme' },
            action: { type: 'allow' },
          },
        ],
        defaultAction: { type: 'block' },
      },
      'linear',
    ]);
  });

  it('rejects names with slashes (would break gateway path routing)', () => {
    expect(() =>
      mcpProjectConfigSchema.parse({ servers: ['foo/bar'] }),
    ).toThrow(/servers/);
  });

  it('rejects object-form entries whose name has slashes', () => {
    expect(() =>
      mcpProjectConfigSchema.parse({
        servers: [{ name: 'foo/bar' }],
      }),
    ).toThrow(/servers/);
  });

  it('rejects names starting with a dash', () => {
    expect(() => mcpProjectConfigSchema.parse({ servers: ['-bad'] })).toThrow(
      /servers/,
    );
  });

  it('rejects empty strings', () => {
    expect(() => mcpProjectConfigSchema.parse({ servers: [''] })).toThrow(
      /servers/,
    );
  });

  it('rejects an empty policies array (use bare-string form for no constraints)', () => {
    expect(() =>
      mcpProjectConfigSchema.parse({
        servers: [{ name: 'github', policies: [] }],
      }),
    ).toThrow(/servers/);
  });

  it('rejects non-scalar argument values', () => {
    expect(() =>
      mcpProjectConfigSchema.parse({
        servers: [
          {
            name: 'github',
            policies: [
              {
                tools: ['t'],
                arguments: { repo: ['a', 'b'] },
                action: { type: 'allow' },
              },
            ],
          },
        ],
      }),
    ).toThrow(/servers/);
  });

  it('accepts numeric and boolean argument values', () => {
    const parsed = mcpProjectConfigSchema.parse({
      servers: [
        {
          name: 'github',
          policies: [
            {
              tools: ['t'],
              arguments: { page: 1, dryRun: true },
              action: { type: 'allow' },
            },
          ],
        },
      ],
    });
    expect(parsed.servers).toHaveLength(1);
  });
});

describe('normalizeServerEntries', () => {
  it('folds bare-string entries into { name, policies: [], defaultAction: "allow" }', () => {
    expect(normalizeServerEntries(['github', 'linear'])).toEqual([
      { name: 'github', policies: [], defaultAction: 'allow' },
      { name: 'linear', policies: [], defaultAction: 'allow' },
    ]);
  });

  it('defaults defaultAction to "block" when policies are set without one', () => {
    expect(
      normalizeServerEntries([
        {
          name: 'github',
          policies: [
            {
              tools: ['t'],
              arguments: { x: 'y' },
              action: { type: 'allow' },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        name: 'github',
        policies: [{ tools: ['t'], arguments: { x: 'y' } }],
        defaultAction: 'block',
      },
    ]);
  });

  it('respects an explicit defaultAction: allow', () => {
    expect(
      normalizeServerEntries([
        {
          name: 'github',
          policies: [{ tools: ['t'], action: { type: 'allow' } }],
          defaultAction: { type: 'allow' },
        },
      ]),
    ).toEqual([
      {
        name: 'github',
        policies: [{ tools: ['t'], arguments: undefined }],
        defaultAction: 'allow',
      },
    ]);
  });

  it('treats object-form with no policies and no defaultAction as bare-string equivalent', () => {
    expect(normalizeServerEntries([{ name: 'github' }])).toEqual([
      { name: 'github', policies: [], defaultAction: 'allow' },
    ]);
  });

  it('mixes bare and object forms in one call', () => {
    expect(
      normalizeServerEntries([
        'github',
        {
          name: 'linear',
          policies: [{ tools: ['list_issues'], action: { type: 'allow' } }],
        },
      ]),
    ).toEqual([
      { name: 'github', policies: [], defaultAction: 'allow' },
      {
        name: 'linear',
        policies: [{ tools: ['list_issues'], arguments: undefined }],
        defaultAction: 'block',
      },
    ]);
  });
});

describe('mcpUserConfigSchema upstreams', () => {
  it('accepts an oauth upstream with default auth (omitted)', () => {
    const parsed = mcpUserConfigSchema.parse({
      upstreams: {
        linear: { url: 'https://mcp.linear.app/sse' },
      },
    });
    expect(parsed.upstreams).toEqual({
      linear: { url: 'https://mcp.linear.app/sse' },
    });
  });

  it('accepts an explicit oauth auth with clientName', () => {
    const parsed = mcpUserConfigSchema.parse({
      upstreams: {
        linear: {
          url: 'https://mcp.linear.app/sse',
          auth: { type: 'oauth', clientName: 'my-cli' },
        },
      },
    });
    expect(parsed.upstreams.linear?.auth).toEqual({
      type: 'oauth',
      clientName: 'my-cli',
    });
  });

  it('accepts a bearer auth with tokenSource', () => {
    const parsed = mcpUserConfigSchema.parse({
      upstreams: {
        'github-pat': {
          url: 'https://api.github.com/mcp/',
          auth: { type: 'bearer', tokenSource: 'env:GH_PAT' },
        },
      },
    });
    expect(parsed.upstreams['github-pat']?.auth).toEqual({
      type: 'bearer',
      tokenSource: 'env:GH_PAT',
    });
  });

  it('rejects bearer auth without tokenSource', () => {
    expect(() =>
      mcpUserConfigSchema.parse({
        upstreams: {
          'github-pat': {
            url: 'https://api.github.com/mcp/',
            auth: { type: 'bearer' },
          },
        },
      }),
    ).toThrow(/tokenSource/);
  });

  it('rejects an unknown auth type', () => {
    expect(() =>
      mcpUserConfigSchema.parse({
        upstreams: {
          x: {
            url: 'https://example.com/mcp/',
            auth: { type: 'basic', user: 'u', password: 'p' },
          },
        },
      }),
    ).toThrow(/auth/);
  });
});

describe('normalizeUpstream', () => {
  it('defaults missing auth to oauth with undefined clientName', () => {
    expect(normalizeUpstream({ url: 'https://x/mcp/' })).toEqual({
      url: 'https://x/mcp/',
      auth: { type: 'oauth', clientName: undefined },
    });
  });

  it('preserves an explicit oauth clientName', () => {
    expect(
      normalizeUpstream({
        url: 'https://x/mcp/',
        auth: { type: 'oauth', clientName: 'svc' },
      }),
    ).toEqual({
      url: 'https://x/mcp/',
      auth: { type: 'oauth', clientName: 'svc' },
    });
  });

  it('preserves a bearer auth verbatim', () => {
    expect(
      normalizeUpstream({
        url: 'https://x/mcp/',
        auth: { type: 'bearer', tokenSource: 'env:T' },
      }),
    ).toEqual({
      url: 'https://x/mcp/',
      auth: { type: 'bearer', tokenSource: 'env:T' },
    });
  });
});

describe('mergeUpstreamCatalogs', () => {
  it('returns user entries normalized when project is empty', () => {
    const merged = mergeUpstreamCatalogs(
      {
        linear: { url: 'https://mcp.linear.app/sse' },
      },
      {},
    );
    expect(merged).toEqual({
      linear: {
        url: 'https://mcp.linear.app/sse',
        auth: { type: 'oauth', clientName: undefined },
      },
    });
  });

  it('adds project-only entries to the merged catalog', () => {
    const merged = mergeUpstreamCatalogs(
      {},
      {
        'github-pat': {
          url: 'https://api.github.com/mcp/',
          auth: { type: 'bearer', tokenSource: 'env:GH_PAT' },
        },
      },
    );
    expect(merged['github-pat']).toEqual({
      url: 'https://api.github.com/mcp/',
      auth: { type: 'bearer', tokenSource: 'env:GH_PAT' },
    });
  });

  it('lets a project entry fully replace the user entry on name collision', () => {
    const merged = mergeUpstreamCatalogs(
      {
        github: {
          url: 'https://api.githubcopilot.com/mcp/',
          auth: { type: 'oauth', clientName: 'user-cli' },
        },
      },
      {
        github: {
          url: 'https://internal-ghe/mcp/',
          auth: { type: 'bearer', tokenSource: 'env:GHE_PAT' },
        },
      },
    );
    expect(merged.github).toEqual({
      url: 'https://internal-ghe/mcp/',
      auth: { type: 'bearer', tokenSource: 'env:GHE_PAT' },
    });
  });
});

describe('mcpProjectConfigSchema upstreams', () => {
  it('accepts a project-scoped upstream catalog', () => {
    const parsed = mcpProjectConfigSchema.parse({
      upstreams: {
        'github-internal': {
          url: 'https://internal-ghe/mcp/',
          auth: { type: 'bearer', tokenSource: 'env:GH_PAT' },
        },
      },
      servers: ['github-internal'],
    });
    expect(parsed.upstreams['github-internal']?.auth).toEqual({
      type: 'bearer',
      tokenSource: 'env:GH_PAT',
    });
  });

  it('defaults project upstreams to {} when omitted', () => {
    const parsed = mcpProjectConfigSchema.parse({});
    expect(parsed.upstreams).toEqual({});
  });
});
