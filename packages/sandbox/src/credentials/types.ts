/**
 * A parsed credential reference of the form `<scheme>:<name>`.
 *
 * `scheme` selects which provider resolves the credential (e.g. `env`,
 * `shell`); `name` is the provider-specific payload (an env-var name, a shell
 * command, etc.).
 */
export interface CredentialSource {
  scheme: string;
  name: string;
}

/**
 * Parse a `<scheme>:<name>` credential reference. Both halves must be
 * non-empty; the scheme allowlist is enforced by the resolver based on
 * registered providers, not here.
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
  if (!name) {
    throw new Error(`Empty credential name in ${JSON.stringify(value)}`);
  }
  return { scheme, name };
}

/**
 * Resolves a {@link CredentialSource} to a secret string. Each provider
 * declares the single scheme it handles; the {@link CredentialCache} dispatches
 * to the matching provider.
 */
export interface CredentialProvider {
  scheme: string;
  resolve: (source: CredentialSource) => Promise<string>;
}
