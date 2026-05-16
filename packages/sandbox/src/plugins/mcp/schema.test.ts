import { describe, expect, it } from 'vitest';

import { mcpProjectConfigSchema } from './schema.js';

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

  it('rejects names with slashes (would break gateway path routing)', () => {
    expect(() =>
      mcpProjectConfigSchema.parse({ servers: ['foo/bar'] }),
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
