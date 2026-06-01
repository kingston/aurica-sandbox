export { CredentialResolver } from './resolver.js';
export type { CredentialResolverOptions } from './resolver.js';
export { createPluginCredentialRecordFactory } from './plugin-credential-record.js';
export type { PluginDefineCredentialRecordOptions } from './plugin-credential-record.js';
export { CredentialStore, defaultCredentialStore } from './credential-store.js';
export type { CredentialStoreOptions } from './credential-store.js';
export {
  defaultCredentialProviders,
  envCredentialProvider,
  ghTokenCredentialProvider,
} from './providers/index.js';
export { parseCredentialSource } from './types.js';
export type { CredentialProvider, CredentialSource } from './types.js';
