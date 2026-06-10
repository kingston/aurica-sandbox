import { describe, expect, it } from 'vitest';

import { DOMAIN_PRESETS, expandDomainTokens } from './domain-presets.js';

describe('expandDomainTokens', () => {
  it('expands a preset to its bucket', () => {
    expect(expandDomainTokens(['preset:common'])).toEqual([
      ...DOMAIN_PRESETS.common,
    ]);
  });

  it('passes the bypass-all token through', () => {
    expect(expandDomainTokens(['*'])).toEqual(['*']);
  });

  it('passes literal domains through unchanged', () => {
    expect(expandDomainTokens(['github.com', '*.example.com'])).toEqual([
      'github.com',
      '*.example.com',
    ]);
  });

  it('mixes presets, bypass, and literals in order', () => {
    expect(expandDomainTokens(['internal.corp.com', 'preset:common'])).toEqual([
      'internal.corp.com',
      ...DOMAIN_PRESETS.common,
    ]);
  });

  it('throws on an unknown preset name', () => {
    expect(() => expandDomainTokens(['preset:nope'])).toThrow(
      /Unknown domain preset "nope"/,
    );
  });
});
