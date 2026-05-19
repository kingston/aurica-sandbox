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

  it('accepts object-form entries with a tool allowlist', () => {
    const parsed = mcpProjectConfigSchema.parse({
      servers: [
        { name: 'linear', tools: ['list_issues', 'save_issue'] },
        'github',
      ],
    });
    expect(parsed.servers).toEqual([
      { name: 'linear', tools: ['list_issues', 'save_issue'] },
      'github',
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
        servers: [{ name: 'foo/bar', tools: [] }],
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
});

describe('normalizeServerEntries', () => {
  it('folds bare-string entries into { name, tools: undefined }', () => {
    expect(normalizeServerEntries(['github', 'linear'])).toEqual([
      { name: 'github', tools: undefined },
      { name: 'linear', tools: undefined },
    ]);
  });

  it('passes object-form entries through unchanged', () => {
    expect(
      normalizeServerEntries([
        { name: 'linear', tools: ['list_issues'] },
        { name: 'sentry-mcp', tools: [] },
      ]),
    ).toEqual([
      { name: 'linear', tools: ['list_issues'] },
      { name: 'sentry-mcp', tools: [] },
    ]);
  });

  it('mixes bare and object forms in one call', () => {
    expect(
      normalizeServerEntries([
        'github',
        { name: 'linear', tools: ['list_issues'] },
      ]),
    ).toEqual([
      { name: 'github', tools: undefined },
      { name: 'linear', tools: ['list_issues'] },
    ]);
  });
});
