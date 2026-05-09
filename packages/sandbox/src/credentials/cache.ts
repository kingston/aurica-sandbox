import { defaultCredentialProviders } from './providers/index.js';
import { parseCredentialSource } from './types.js';
import type { CredentialProvider } from './types.js';

interface CacheEntry {
  value: string;
  lastUsedAt: number;
}

export interface CredentialCacheOptions {
  idleTimeoutSeconds: number;
  now?: () => number;
  providers?: readonly CredentialProvider[];
}

export class CredentialCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly providers: readonly CredentialProvider[];

  constructor(options: CredentialCacheOptions) {
    this.idleMs = options.idleTimeoutSeconds * 1000;
    this.now = options.now ?? Date.now;
    this.providers = options.providers ?? defaultCredentialProviders;
  }

  /**
   * Resolve a `<scheme>:<name>` credential reference, caching the result.
   * Entries expire after `idleTimeoutSeconds` of inactivity; each successful
   * hit refreshes the timestamp.
   */
  async resolve(rawSource: string): Promise<string> {
    const t = this.now();
    const existing = this.entries.get(rawSource);
    if (existing && t - existing.lastUsedAt <= this.idleMs) {
      existing.lastUsedAt = t;
      return existing.value;
    }
    if (existing) this.entries.delete(rawSource);

    const source = parseCredentialSource(rawSource);
    const provider = this.providers.find((p) => p.scheme === source.scheme);
    if (!provider) {
      throw new Error(
        `No credential provider registered for scheme ${JSON.stringify(source.scheme)}`,
      );
    }
    const value = await provider.resolve(source);
    this.entries.set(rawSource, { value, lastUsedAt: t });
    return value;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
