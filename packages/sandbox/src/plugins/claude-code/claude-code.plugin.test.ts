import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultCredentialStore } from '#src/credentials/credential-store.js';

import {
  expandPlugins,
  type ProjectPlugins,
  type UserPlugins,
} from '../index.js';
import { claudeRecord } from './oauth.js';

const PLACEHOLDER_RE = /^__AURICA_TOKEN_[0-9A-F]{16}__$/;

const ctx = {
  linuxUser: 'sandbox',
  sandboxName: 'sb-test',
  authSecret: 'test-secret',
};
const emptyUser: UserPlugins = {};

/**
 * Per-test redirect of `AURICA_HOME` into a tmpdir so subscription-mode
 * expansions read an empty slot store by default. Tests that need the
 * "slot already populated" branch write to {@link claudeRecord} after the
 * redirect is in place.
 */
let credsDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  credsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-claude-plugin-'));
  prevHome = process.env.AURICA_HOME;
  process.env.AURICA_HOME = credsDir;
});

afterEach(async () => {
  if (prevHome === undefined) {
    delete process.env.AURICA_HOME;
  } else {
    process.env.AURICA_HOME = prevHome;
  }
  await fs.rm(credsDir, { recursive: true, force: true });
});

describe('expandPlugins — claude-code', () => {
  it('emits installer + api domains, the apiKeyHelper settings file, and an x-api-key substitution policy + Authorization strip in api-key mode', async () => {
    const project: ProjectPlugins = {
      'claude-code': { authMode: 'api-key' },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

    expect(new Set(expanded.domains)).toEqual(
      new Set(['claude.ai', 'downloads.claude.ai']),
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

    expect(expanded.commands).toHaveLength(2);
    const settingsCmd = expanded.commands[0];
    if (!settingsCmd) throw new Error('expected settings command');
    expect(settingsCmd.user).toBe('default');
    expect(settingsCmd.argv[0]).toBe('sh');
    expect(settingsCmd.argv[2]).toMatch(/\$HOME\/\.claude\/settings\.json/);
    const body = settingsCmd.argv[4] ?? '';
    const parsed = JSON.parse(body) as {
      apiKeyHelper: string;
      env: Record<string, string>;
    };
    expect(parsed.apiKeyHelper).toBe(`/bin/echo ${replace.from}`);
    expect(parsed.env).toEqual({
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    });

    const claudeJsonCmd = expanded.commands[1];
    if (!claudeJsonCmd) throw new Error('expected claude.json command');
    expect(claudeJsonCmd.user).toBe('default');
    expect(claudeJsonCmd.argv[0]).toBe('sh');
    const claudeJsonScript = claudeJsonCmd.argv[2] ?? '';
    expect(claudeJsonScript).toMatch(/\$HOME\/\.claude\.json/);
    expect(claudeJsonScript).toMatch(/AURICA_PROJECT_DIR/);
    expect(claudeJsonScript).toMatch(/hasCompletedOnboarding/);
    expect(claudeJsonScript).toMatch(/"theme": "auto"/);
    expect(claudeJsonScript).toMatch(/hasTrustDialogAccepted/);
    expect(claudeJsonScript).toMatch(/chmod 600/);

    expect(expanded.bootstrapScript).toMatch(
      /sudo -iu sandbox bash -lc 'curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash'/,
    );
  });

  it('substitutes into Authorization and strips x-api-key in oauth-token mode', async () => {
    const project: ProjectPlugins = {
      'claude-code': { authMode: 'oauth-token' },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

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

  it('defaults to the claude-oauth credential source in subscription mode', async () => {
    const project: ProjectPlugins = {
      'claude-code': { authMode: 'subscription' },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

    const apiPolicy = expanded.policies.find((p) => p.id === 'claude-code:api');
    if (apiPolicy?.action.type !== 'allow') {
      throw new Error('expected allow policy on api.anthropic.com');
    }
    const muts = apiPolicy.action.mutations ?? [];
    expect(muts).toHaveLength(2);
    const replace = muts[0];
    if (replace?.kind !== 'replace-header') {
      throw new Error('expected replace-header mutation first');
    }
    expect(replace.header).toBe('Authorization');
    expect(replace.to).toBe('vault:claude-code:oauth#accessToken');
    expect(muts[1]).toEqual({ kind: 'remove-header', header: 'x-api-key' });

    // Subscription mode also adds an oauth-token-response interceptor on
    // platform.claude.com so the guest's `/login` POST is captured.
    const oauthPolicy = expanded.policies.find(
      (p) => p.id === 'claude-code:oauth-token',
    );
    expect(oauthPolicy).toBeDefined();
    if (oauthPolicy?.action.type !== 'allow') {
      throw new Error('expected allow policy with interceptResponse');
    }
    expect(oauthPolicy.action.interceptResponse?.kind).toBe(
      'oauth-token-response',
    );
    expect(oauthPolicy.action.interceptResponse?.recordKey).toBe(
      'claude-code:oauth',
    );

    // No prior login on this host → no `.credentials.json` seed command.
    // The settings.json + claude.json pair are the only post-lockdown
    // commands; the guest will show its native "not logged in" state and
    // the user runs `claude /login` to populate the slot for next time.
    const credsCmd = expanded.commands.find((c) =>
      c.argv.some(
        (arg) =>
          typeof arg === 'string' && arg.includes('.claude/.credentials.json'),
      ),
    );
    expect(credsCmd).toBeUndefined();
  });

  it('seeds .credentials.json with the cached slot metadata when a prior login exists', async () => {
    const now = Date.now();
    await defaultCredentialStore.write(claudeRecord, {
      accessToken: 'cached-access',
      refreshToken: 'cached-refresh',
      expiresAt: now + 3_600_000,
      obtainedAt: now,
      scopes: ['user:inference', 'user:profile', 'org:read'],
      extras: { subscriptionType: 'team' },
      currentCounter: 5,
    });

    const project: ProjectPlugins = {
      'claude-code': { authMode: 'subscription' },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

    const credsCmd = expanded.commands.find((c) =>
      c.argv.some(
        (arg) =>
          typeof arg === 'string' && arg.includes('.claude/.credentials.json'),
      ),
    );
    if (!credsCmd) throw new Error('expected credentials.json command');
    const body = credsCmd.argv[4] ?? '';
    const parsed = JSON.parse(body) as {
      claudeAiOauth: {
        accessToken: string;
        refreshToken: string;
        scopes: string[];
        subscriptionType: string;
      };
    };
    // Real metadata (scopes + tier) from the slot; tokens stay
    // placeholders so the guest can't read the real ones off disk.
    expect(parsed.claudeAiOauth.scopes).toEqual([
      'user:inference',
      'user:profile',
      'org:read',
    ]);
    expect(parsed.claudeAiOauth.subscriptionType).toBe('team');
    expect(parsed.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat01-aurica-/);
    // Refresh placeholder embeds the slot's currentCounter so the guest's
    // first refresh attempt matches host view (5 was seeded above).
    expect(parsed.claudeAiOauth.refreshToken).toMatch(
      /^sk-ant-ort01-aurica-__AURICA_TOKEN_[0-9A-F]{16}__:5$/,
    );
  });

  it('honours an explicit tokenSource override', async () => {
    const project: ProjectPlugins = {
      'claude-code': {
        authMode: 'api-key',
        tokenSource: 'env:MY_CUSTOM_KEY',
      },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);

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

  it('does not allowlist OAuth-flow or telemetry hosts', async () => {
    const project: ProjectPlugins = {
      'claude-code': { authMode: 'oauth-token' },
    };
    const expanded = await expandPlugins(project, emptyUser, ctx);
    expect(expanded.domains).not.toContain('console.anthropic.com');
    expect(expanded.domains).not.toContain('statsig.anthropic.com');
  });
});
