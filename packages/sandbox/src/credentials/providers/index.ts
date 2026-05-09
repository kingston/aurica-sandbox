import type { CredentialProvider } from '../types.js';
import { envCredentialProvider } from './env.js';
import { shellCredentialProvider } from './shell.js';

export { envCredentialProvider } from './env.js';
export { shellCredentialProvider } from './shell.js';

/**
 * Default set of credential providers wired into the {@link CredentialCache}
 * when none are supplied explicitly.
 */
export const defaultCredentialProviders: readonly CredentialProvider[] = [
  envCredentialProvider,
  shellCredentialProvider,
];
