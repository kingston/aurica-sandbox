import { defaultCredentialProviders } from './providers/index.js';
import { parseCredentialSource } from './types.js';
import type { CredentialProvider } from './types.js';

export interface CredentialResolverOptions {
  providers?: readonly CredentialProvider[];
}

/** Resolves `<scheme>:<name>` credential references by delegating to the matching provider. */
export class CredentialResolver {
  readonly #providers: readonly CredentialProvider[];

  constructor(options: CredentialResolverOptions = {}) {
    this.#providers = options.providers ?? defaultCredentialProviders;
  }

  /** Resolve a `<scheme>:<name>` credential reference. */
  async resolve(rawSource: string): Promise<string> {
    const source = parseCredentialSource(rawSource);
    const provider = this.#providers.find((p) => p.scheme === source.scheme);
    if (!provider) {
      throw new Error(
        `No credential provider registered for scheme ${JSON.stringify(source.scheme)}`,
      );
    }
    return provider.resolve(source);
  }
}
