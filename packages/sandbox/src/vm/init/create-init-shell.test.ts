import { describe, expect, it } from 'vitest';

import { createInitShell } from './create-init-shell.js';

const FIXTURE_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKHHIgIIsgQyMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWZp
eHR1cmVDQTAeFw0yNTAxMDEwMDAwMDBaFw0zNTAxMDEwMDAwMDBaMBQxEjAQBgNV
BAMMCWZpeHR1cmVDQTBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC1FIXTUREVI3Ec
0pE6PpGDNKfP5LLxZxPyZbPYx8XR3PcPwfYFx9c5gK+sR2IpzkR7LsMI3z4JCUaT
0eF1QZqpAgMBAAEwDQYJKoZIhvcNAQELBQADQQABFAKEVIXTUREVI3Ec0pE6PpGD
NKfP5LLxZxPyZbPYx8XR3PcPwfYFx9c5gK+sR2IpzkR7LsMI3z4JCUaT0eF1QZqp
-----END CERTIFICATE-----
`;

describe('createInitShell', () => {
  it('produces the expected bootstrap script with no plugin snippets', () => {
    const script = createInitShell({
      user: 'sandbox',
      proxyHost: '192.168.139.3',
      proxyPort: 9999,
      caCertPem: FIXTURE_CA_PEM,
      pluginBootstrap: '',
    });
    expect(script).toMatchSnapshot();
  });

  it('produces the expected bootstrap script with a single plugin snippet', () => {
    const script = createInitShell({
      user: 'sandbox',
      proxyHost: '192.168.139.3',
      proxyPort: 9999,
      caCertPem: FIXTURE_CA_PEM,
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
      caCertPem: FIXTURE_CA_PEM,
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
        caCertPem: FIXTURE_CA_PEM,
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
        caCertPem: FIXTURE_CA_PEM,
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
        caCertPem: FIXTURE_CA_PEM,
        pluginBootstrap: '',
      }),
    ).toThrow(/proxyPort/);
    expect(() =>
      createInitShell({
        user: 'sandbox',
        proxyHost: 'host.orb.internal',
        proxyPort: 70_000,
        caCertPem: FIXTURE_CA_PEM,
        pluginBootstrap: '',
      }),
    ).toThrow(/proxyPort/);
  });

  it('rejects an empty caCertPem', () => {
    expect(() =>
      createInitShell({
        user: 'sandbox',
        proxyHost: 'host.orb.internal',
        proxyPort: 9999,
        caCertPem: '',
        pluginBootstrap: '',
      }),
    ).toThrow(/caCertPem/);
  });

  it('rejects a caCertPem missing the PEM header', () => {
    expect(() =>
      createInitShell({
        user: 'sandbox',
        proxyHost: 'host.orb.internal',
        proxyPort: 9999,
        caCertPem: 'not a certificate',
        pluginBootstrap: '',
      }),
    ).toThrow(/caCertPem/);
  });

  it('removes the OrbStack passwordless-sudo grant', () => {
    const script = createInitShell({
      user: 'sandbox',
      proxyHost: '192.168.139.3',
      proxyPort: 9999,
      caCertPem: FIXTURE_CA_PEM,
      pluginBootstrap: '',
    });
    expect(script).toContain('rm -f /etc/sudoers.d/orbstack');
  });

  it('never re-introduces a NOPASSWD rule', () => {
    const script = createInitShell({
      user: 'sandbox',
      proxyHost: '192.168.139.3',
      proxyPort: 9999,
      caCertPem: FIXTURE_CA_PEM,
      pluginBootstrap: '# fake plugin\necho hello',
    });
    expect(script).not.toMatch(/NOPASSWD/);
  });
});
