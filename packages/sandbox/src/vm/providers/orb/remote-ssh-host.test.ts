import { describe, expect, it } from 'vitest';

import { orbProvider } from './provider.js';

describe('orbProvider.remoteSshHost', () => {
  it('addresses an OrbStack machine as `<name>@orb`', () => {
    expect(orbProvider.remoteSshHost('ktam-tools')).toBe('ktam-tools@orb');
  });
});
