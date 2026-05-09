import { describe, expect, it } from 'vitest';

import { createInitShell } from './create-init-shell.js';

describe('createInitShell', () => {
  it('produces the expected bootstrap script with no plugin snippets', () => {
    const script = createInitShell({
      user: 'sandbox',
      proxyHost: '192.168.139.3',
      proxyPort: 9999,
      pluginBootstrap: '',
    });
    expect(script).toMatchSnapshot();
  });

  it('produces the expected bootstrap script with a single plugin snippet', () => {
    const script = createInitShell({
      user: 'sandbox',
      proxyHost: '192.168.139.3',
      proxyPort: 9999,
      pluginBootstrap: `# fake plugin
echo hello`,
    });
    expect(script).toMatchSnapshot();
  });

  it('produces the expected bootstrap script with multiple plugin snippets', () => {
    const script = createInitShell({
      user: 'sandbox',
      proxyHost: '192.168.139.3',
      proxyPort: 9999,
      pluginBootstrap: `# fake plugin a
echo a

# fake plugin b
echo b`,
    });
    expect(script).toMatchSnapshot();
  });

  it('rejects a username with shell metacharacters', () => {
    expect(() =>
      createInitShell({
        user: 'sandbox; rm -rf /',
        proxyHost: 'host.orb.internal',
        proxyPort: 9999,
        pluginBootstrap: '',
      }),
    ).toThrow(/user/);
  });

  it('rejects a proxyHost with shell metacharacters', () => {
    expect(() =>
      createInitShell({
        user: 'sandbox',
        proxyHost: 'host.orb.internal; echo pwned',
        proxyPort: 9999,
        pluginBootstrap: '',
      }),
    ).toThrow(/proxyHost/);
  });

  it('rejects an out-of-range proxy port', () => {
    expect(() =>
      createInitShell({
        user: 'sandbox',
        proxyHost: 'host.orb.internal',
        proxyPort: 0,
        pluginBootstrap: '',
      }),
    ).toThrow(/proxyPort/);
    expect(() =>
      createInitShell({
        user: 'sandbox',
        proxyHost: 'host.orb.internal',
        proxyPort: 70_000,
        pluginBootstrap: '',
      }),
    ).toThrow(/proxyPort/);
  });
});
