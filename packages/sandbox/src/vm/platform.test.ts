import { afterEach, describe, expect, it } from 'vitest';

import { assertPlatformSupported, isPlatformSupported } from './platform.js';

const original = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  setPlatform(original);
});

describe('platform guard', () => {
  it('passes on darwin', () => {
    setPlatform('darwin');
    expect(isPlatformSupported()).toBe(true);
    expect(() => {
      assertPlatformSupported();
    }).not.toThrow();
  });

  it('rejects non-darwin platforms with an actionable message', () => {
    setPlatform('linux');
    expect(isPlatformSupported()).toBe(false);
    expect(() => {
      assertPlatformSupported();
    }).toThrow(/macOS with OrbStack/);
    expect(() => {
      assertPlatformSupported();
    }).toThrow(/linux/);
  });
});
