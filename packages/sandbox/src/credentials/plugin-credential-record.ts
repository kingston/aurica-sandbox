import {
  defineCredentialRecord,
  type CredentialRecord,
  type DefineCredentialRecordOptions,
} from './credential-record.js';

/**
 * Options for a plugin-scoped credential record — identical to
 * {@link DefineCredentialRecordOptions} minus `key`, which is derived from
 * the plugin name + caller-supplied suffix.
 */
export type PluginDefineCredentialRecordOptions<
  TMeta extends object,
  TSecretField extends string,
> = Omit<DefineCredentialRecordOptions<TMeta, TSecretField>, 'key'>;

/**
 * Returns a `defineCredentialRecord` variant that automatically prefixes
 * every record key with `<pluginName>:`, turning a loose convention into a
 * structural guarantee. Call once per plugin with the plugin's `name` field:
 *
 * ```ts
 * const defineRecord = createPluginCredentialRecordFactory('claude-code');
 * export const claudeRecord = defineRecord('oauth', { metadataSchema, secretFields });
 * // claudeRecord.key === 'claude-code:oauth'
 * ```
 */
export function createPluginCredentialRecordFactory(pluginName: string) {
  return function pluginDefineCredentialRecord<
    TMeta extends object,
    const TSecretField extends string,
  >(
    suffix: string,
    opts: PluginDefineCredentialRecordOptions<TMeta, TSecretField>,
  ): CredentialRecord<TMeta, TSecretField> {
    return defineCredentialRecord({ key: `${pluginName}:${suffix}`, ...opts });
  };
}
