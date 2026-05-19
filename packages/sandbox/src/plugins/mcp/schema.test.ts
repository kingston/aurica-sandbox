import { describe, expect, it } from 'vitest';

import { mcpProjectConfigSchema, normalizeServerEntries } from './schema.js';

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
