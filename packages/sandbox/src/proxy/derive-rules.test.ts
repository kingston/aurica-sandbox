import { describe, expect, it } from 'vitest';

import type { ProxyPolicy, SandboxConfig } from '#src/config/index.js';
import type { ProjectPlugins, UserPlugins } from '#src/plugins/index.js';

import { deriveRulesFromConfig } from './derive-rules.js';
import { DOMAIN_PRESETS } from './domain-presets.js';

const ctx = {
  user: 'sandbox',
  sandboxName: 'sb-test',
  authSecret: 'test-secret',
};

function configWith(
  proxy: SandboxConfig['proxy'],
  plugins: ProjectPlugins = {} as ProjectPlugins,
): SandboxConfig {
  return {
    name: 'sb-test',
    proxy,
    files: [],
    mounts: [],
    plugins,
    userPlugins: {} as UserPlugins,
  };
}

describe('deriveRulesFromConfig', () => {
  it('expands preset:common into the allowlist while keeping configDomains raw', async () => {
    const rules = await deriveRulesFromConfig(
      configWith({ domains: ['preset:common'], policies: [] }),
      ctx,
    );
    for (const domain of DOMAIN_PRESETS.common) {
      expect(rules.domains).toContain(domain);
    }
    // The reload banner shows what the user literally typed, not the expansion.
    expect(rules.configDomains).toEqual(['preset:common']);
  });

  it('backfills a synthetic id on a user policy that omitted one', async () => {
    const policy: ProxyPolicy = {
      domain: 'example.com',
      action: { type: 'block' },
    };
    const rules = await deriveRulesFromConfig(
      configWith({ domains: [], policies: [policy] }),
      ctx,
    );
    expect(rules.policies).toHaveLength(1);
    expect(rules.policies[0]?.id).toBe('example.com:block');
  });

  it('deduplicates a preset domain that a plugin also contributes', async () => {
    const rules = await deriveRulesFromConfig(
      configWith({ domains: ['preset:common'], policies: [] }, {
        mise: {},
      } as ProjectPlugins),
      ctx,
    );
    // mise contributes github.com; preset:common contributes it too.
    const count = rules.domains.filter((d) => d === 'github.com').length;
    expect(count).toBe(1);
  });
});
