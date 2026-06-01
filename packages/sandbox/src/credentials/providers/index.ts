import type { CredentialProvider } from '../types.js';
import { envCredentialProvider } from './env.js';
import { ghTokenCredentialProvider } from './gh-token.js';
import { vaultCredentialProvider } from './vault.js';

export { envCredentialProvider } from './env.js';
export { ghTokenCredentialProvider } from './gh-token.js';
export { vaultCredentialProvider } from './vault.js';

/**
 * Default set of credential providers wired into the {@link CredentialResolver}
 * when none are supplied explicitly.
 */
export const defaultCredentialProviders: readonly CredentialProvider[] = [
  envCredentialProvider,
  ghTokenCredentialProvider,
  vaultCredentialProvider,
];
