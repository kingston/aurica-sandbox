/**
 * A parsed credential reference of the form `<scheme>:<name>` or `<scheme>`.
 *
 * `scheme` selects which provider resolves the credential (e.g. `env`,
 * `gh-token`); `name` is the provider-specific payload (an env-var name for
 * `env`, empty for argument-less providers like `gh-token`).
 */
export interface CredentialSource {
  scheme: string;
  name: string;
}

/**
 * Parse a `<scheme>:<name>` credential reference. The scheme half must be
 * non-empty; the name half may be empty (for argument-less providers like
 * `gh-token`). The scheme allowlist is enforced by the resolver based on
 * registered providers, not here.
 */
export function parseCredentialSource(value: string): CredentialSource {
  const idx = value.indexOf(':');
  if (idx === 0) {
    throw new Error(
      `Invalid credential source ${JSON.stringify(value)}: scheme is empty`,
    );
  }
  if (idx === -1) {
    if (!value) {
      throw new Error(
        `Invalid credential source ${JSON.stringify(value)}: scheme is empty`,
      );
    }
    return { scheme: value, name: '' };
  }
  return { scheme: value.slice(0, idx), name: value.slice(idx + 1) };
}

/**
 * Resolves a {@link CredentialSource} to a secret string. Each provider
 * declares the single scheme it handles; the {@link CredentialResolver}
 * dispatches to the matching provider.
 */
export interface CredentialProvider {
  scheme: string;
  resolve: (source: CredentialSource) => Promise<string>;
}
