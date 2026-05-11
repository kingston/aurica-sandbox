import { describe, expect, it } from 'vitest';

import {
  expandPlugins,
  type ProjectPlugins,
  type UserPlugins,
} from '../index.js';

const PLACEHOLDER_RE = /^__AURICA_TOKEN_[0-9A-F]{16}__$/;

const ctx = { linuxUser: 'sandbox' };
const emptyUser: UserPlugins = {};

describe('expandPlugins — claude-code', () => {
  it('emits installer + api domains, the apiKeyHelper settings file, and an x-api-key substitution policy + Authorization strip in api-key mode', () => {
    const project: ProjectPlugins = {
      'claude-code': { authMode: 'api-key' },
    };
    const expanded = expandPlugins(project, emptyUser, ctx);

    expect(new Set(expanded.domains)).toEqual(
      new Set(['claude.ai', 'downloads.claude.ai', 'api.anthropic.com']),
    );

    expect(expanded.policies).toHaveLength(1);
    const policy = expanded.policies[0];
    if (!policy) throw new Error('expected one policy');
    expect(policy.id).toBe('claude-code:api');
    expect(policy.domain).toBe('api.anthropic.com');
    expect(policy.matchers).toBeUndefined();
    if (policy.action.type !== 'allow') throw new Error('expected allow');
    const muts = policy.action.mutations ?? [];
    expect(muts).toHaveLength(2);
    const replace = muts[0];
    if (replace?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation first');
    }
    expect(replace.header).toBe('x-api-key');
    expect(replace.from).toMatch(PLACEHOLDER_RE);
    expect(replace.to).toBe('env:ANTHROPIC_API_KEY');
    expect(replace.transform).toBeUndefined();
    expect(muts[1]).toEqual({ kind: 'remove-header', header: 'Authorization' });

    expect(expanded.commands).toHaveLength(1);
    const cmd = expanded.commands[0];
    if (!cmd) throw new Error('expected one command');
    expect(cmd.user).toBe('default');
    expect(cmd.argv[0]).toBe('sh');
    expect(cmd.argv[2]).toMatch(/\$HOME\/\.claude\/settings\.json/);
    const body = cmd.argv[4] ?? '';
    const parsed = JSON.parse(body) as {
      apiKeyHelper: string;
      env: Record<string, string>;
    };
    expect(parsed.apiKeyHelper).toBe(`/bin/echo ${replace.from}`);
    expect(parsed.env).toEqual({
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    });

    expect(expanded.bootstrapScript).toMatch(
      /sudo -iu sandbox bash -lc 'curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash'/,
    );
  });

  it('substitutes into Authorization and strips x-api-key in oauth-token mode', () => {
    const project: ProjectPlugins = {
      'claude-code': { authMode: 'oauth-token' },
    };
    const expanded = expandPlugins(project, emptyUser, ctx);

    const policy = expanded.policies[0];
    if (policy?.action.type !== 'allow') {
      throw new Error('expected allow policy');
    }
    const muts = policy.action.mutations ?? [];
    expect(muts).toHaveLength(2);
    const replace = muts[0];
    if (replace?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation first');
    }
    expect(replace.header).toBe('Authorization');
    expect(replace.to).toBe('env:CLAUDE_CODE_OAUTH_TOKEN');
    expect(muts[1]).toEqual({ kind: 'remove-header', header: 'x-api-key' });
  });

  it('honours an explicit tokenSource override', () => {
    const project: ProjectPlugins = {
      'claude-code': {
        authMode: 'api-key',
        tokenSource: 'env:MY_CUSTOM_KEY',
      },
    };
    const expanded = expandPlugins(project, emptyUser, ctx);

    const policy = expanded.policies[0];
    if (policy?.action.type !== 'allow') {
      throw new Error('expected allow policy');
    }
    const mut = policy.action.mutations?.[0];
    if (mut?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation');
    }
    expect(mut.to).toBe('env:MY_CUSTOM_KEY');
  });

  it('does not allowlist OAuth-flow or telemetry hosts', () => {
    const project: ProjectPlugins = {
      'claude-code': { authMode: 'oauth-token' },
    };
    const expanded = expandPlugins(project, emptyUser, ctx);
    expect(expanded.domains).not.toContain('console.anthropic.com');
    expect(expanded.domains).not.toContain('statsig.anthropic.com');
  });
});
