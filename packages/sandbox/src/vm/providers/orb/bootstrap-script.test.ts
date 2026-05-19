import { describe, expect, it } from 'vitest';

import { orbBootstrapScript } from './bootstrap-script.js';

describe('orbBootstrapScript', () => {
  it('removes the OrbStack passwordless-sudo grant', () => {
    expect(orbBootstrapScript).toContain('rm -f /etc/sudoers.d/orbstack');
  });

  it('never contains a NOPASSWD rule', () => {
    expect(orbBootstrapScript).not.toMatch(/NOPASSWD/);
  });

  it('guards the removal on file existence', () => {
    expect(orbBootstrapScript).toContain('if [ -f /etc/sudoers.d/orbstack ]');
  });
});
