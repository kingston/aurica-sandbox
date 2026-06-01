import { vaultSecretKey } from '../credential-store.js';
import { defaultSecretVault } from '../secret-vault.js';
import type { CredentialProvider, CredentialSource } from '../types.js';

/**
 * Resolves credentials of the form `vault:<record-key>#<field>` to the
 * value persisted in the secret vault under `<record-key>:<field>`.
 *
 * Both the record key and the field suffix are required. Throws when
 * either is absent, or when the secret hasn't been populated yet —
 * caller (proxy substitution) surfaces this as a 401 to the guest.
 */
export const vaultCredentialProvider: CredentialProvider = {
  scheme: 'vault',
  async resolve(source: CredentialSource): Promise<string> {
    if (!source.name) {
      throw new Error('vault: credential source requires a record key');
    }
    const hashIdx = source.name.indexOf('#');
    const recordKey =
      hashIdx === -1 ? source.name : source.name.slice(0, hashIdx);
    const field = hashIdx === -1 ? '' : source.name.slice(hashIdx + 1);
    if (!recordKey) {
      throw new Error('vault: credential source requires a record key');
    }
    if (!field) {
      throw new Error(
        `vault:${source.name} requires a field suffix, e.g. vault:${source.name}#accessToken`,
      );
    }
    const secretsKey = vaultSecretKey(recordKey, field);
    const value = await defaultSecretVault.get(secretsKey);
    if (value === undefined) {
      throw new Error(
        `vault:${source.name} is not populated (looked up ${secretsKey}). The guest VM has not completed an OAuth login for this record yet.`,
      );
    }
    return value;
  },
};
