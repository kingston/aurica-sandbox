/**
 * The allowlist-bypass token. When `proxy.domains` contains this value the
 * proxy allows egress to **any** host — the domain allowlist is effectively
 * off. Matched as a bare `*` wildcard by `matchDomain`.
 */
export const BYPASS_ALL = '*';

/** Prefix marking a `proxy.domains` entry as a named preset (e.g. `preset:common`). */
export const PRESET_PREFIX = 'preset:';

/**
 * Built-in domain buckets, keyed by preset name. A `proxy.domains` entry of
 * `preset:<name>` expands to the matching bucket's domains before the
 * allowlist is built. Mirrors the `env:`/`vault:` prefix convention used by
 * credential sources elsewhere in the config.
 *
 * `common` covers the baseline egress most coding agents need — OS package
 * mirrors, language registries, and git hosts — so projects don't have to
 * re-list them. It deliberately overlaps with the `mise`/`github` plugins;
 * domains are deduplicated when the allowlist is derived, so enabling both is
 * harmless. Use `common` when those plugins are not enabled.
 */
export const DOMAIN_PRESETS = {
  common: [
    // OS package mirrors
    '*.ubuntu.com',
    'deb.debian.org',
    // Rust / crates
    'crates.io',
    'index.crates.io',
    'static.crates.io',
    // Python
    'pypi.org',
    '*.pythonhosted.org',
    // Node / npm / yarn
    '*.npmjs.org',
    '*.npmjs.com',
    'registry.yarnpkg.com',
    'yarnpkg.com',
    // GitHub + git hosts
    'github.com',
    '*.githubusercontent.com',
    'codeload.github.com',
  ],
};

/**
 * Expand the raw `proxy.domains` tokens into concrete allowlist patterns.
 *
 * - `*` passes through as the bypass-all wildcard.
 * - `preset:<name>` expands to {@link DOMAIN_PRESETS}`[name]`.
 * - any other token is a literal domain / wildcard pattern, returned as-is.
 *
 * Throws on an unknown preset name so config typos surface loudly rather than
 * silently allowing nothing.
 */
export function expandDomainTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.startsWith(PRESET_PREFIX)) {
      const name = token.slice(PRESET_PREFIX.length);
      if (!Object.hasOwn(DOMAIN_PRESETS, name)) {
        const known = Object.keys(DOMAIN_PRESETS).join(', ');
        throw new Error(
          `Unknown domain preset "${name}" in proxy.domains. Known presets: ${known}.`,
        );
      }
      out.push(...DOMAIN_PRESETS[name as keyof typeof DOMAIN_PRESETS]);
    } else {
      out.push(token);
    }
  }
  return out;
}
