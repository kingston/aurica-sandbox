import type { CredentialProvider, CredentialSource } from '../types.js';

/**
 * Resolves credentials of the form `env:<VAR>` from `process.env`.
 * Throws if the variable is unset or empty.
 */
export const envCredentialProvider: CredentialProvider = {
  scheme: 'env',
  resolve(source: CredentialSource): Promise<string> {
    const value = process.env[source.name];
    if (value === undefined || value === '') {
      return Promise.reject(
        new Error(
          `Environment variable ${source.name} is not set (required by env: credential source)`,
        ),
      );
    }
    return Promise.resolve(value);
  },
};
