import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertPlatformSupported, isPlatformSupported } from './platform.js';

const originalPlatform = process.platform;
const originalSkip = process.env.AURICA_SKIP_PLATFORM_CHECK;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  // The global test setup sets the skip flag for the rest of the suite; clear
  // it here so these tests exercise the real platform logic.
  delete process.env.AURICA_SKIP_PLATFORM_CHECK;
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalSkip === undefined) delete process.env.AURICA_SKIP_PLATFORM_CHECK;
  else process.env.AURICA_SKIP_PLATFORM_CHECK = originalSkip;
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

  it('bypasses the check when AURICA_SKIP_PLATFORM_CHECK is set', () => {
    setPlatform('linux');
    process.env.AURICA_SKIP_PLATFORM_CHECK = '1';
    expect(() => {
      assertPlatformSupported();
    }).not.toThrow();
  });
});
