export interface CredentialSource {
  scheme: 'env';
  name: string;
}

/**
 * Parse a `<scheme>:<name>` credential reference. v1 only accepts the `env`
 * scheme; everything else throws.
 */
export function parseCredentialSource(value: string): CredentialSource {
  const idx = value.indexOf(':');
  if (idx <= 0) {
    throw new Error(
      `Invalid credential source ${JSON.stringify(value)}: expected "<scheme>:<name>"`,
    );
  }
  const scheme = value.slice(0, idx);
  const name = value.slice(idx + 1);
  if (scheme !== 'env') {
    throw new Error(
      `Unsupported credential scheme ${JSON.stringify(scheme)}; v1 only supports "env"`,
    );
  }
  if (!name) {
    throw new Error(`Empty credential name in ${JSON.stringify(value)}`);
  }
  return { scheme, name };
}

export interface CredentialProvider {
  scheme: 'env';
  resolve: (source: CredentialSource) => Promise<string>;
}
