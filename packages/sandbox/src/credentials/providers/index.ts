import type { CredentialProvider } from '../types.js';
import { envCredentialProvider } from './env.js';
import { ghTokenCredentialProvider } from './gh-token.js';

export { envCredentialProvider } from './env.js';
export { ghTokenCredentialProvider } from './gh-token.js';

/**
 * Default set of credential providers wired into the {@link CredentialCache}
 * when none are supplied explicitly.
 */
export const defaultCredentialProviders: readonly CredentialProvider[] = [
  envCredentialProvider,
  ghTokenCredentialProvider,
];
