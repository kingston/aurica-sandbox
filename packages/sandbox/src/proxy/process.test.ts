import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvedProxyPort } from './process.js';

describe('resolvedProxyPort', () => {
  const real = process.env.AURICA_PROXY_PORT;

  beforeEach(() => {
    delete process.env.AURICA_PROXY_PORT;
  });

  afterEach(() => {
    if (real === undefined) delete process.env.AURICA_PROXY_PORT;
    else process.env.AURICA_PROXY_PORT = real;
  });

  it('defaults to 51217 when unset', () => {
    expect(resolvedProxyPort()).toBe(51_217);
  });

  it('uses a valid AURICA_PROXY_PORT override', () => {
    process.env.AURICA_PROXY_PORT = '51218';
    expect(resolvedProxyPort()).toBe(51_218);
  });

  it('falls back to the default for an out-of-range or non-numeric value', () => {
    for (const bad of ['0', '70000', 'abc', '-1', '']) {
      process.env.AURICA_PROXY_PORT = bad;
      expect(resolvedProxyPort()).toBe(51_217);
    }
  });
});
