import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

import type { ExpandedPlugin, PluginExpansionContext } from '../types.js';
import type { MisePlugin } from './schema.js';

/**
 * Hosts mise reaches both for its own install and for `mise install <tool>`
 * post-lockdown. The first two are mise itself; the rest are common
 * language-runtime CDNs so pulling down Node, Python, Rust, Go etc. works
 * out of the box without each project having to enumerate them in
 * `proxy.domains`. Opinionated by design — anyone using mise is implicitly
 * asking for these.
 */
const MISE_DOMAINS = [
  'mise.run',
  'mise.jdx.dev',
  'mise-versions.jdx.dev',
  'nodejs.org',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'static.rust-lang.org',
  'go.dev',
  'storage.googleapis.com',
] as const;

/**
 * Build the pre-lockdown shell snippet that installs mise into `<user>`'s
 * `~/.local/bin`. `sudo -iu` gives a login shell so PATH picks up the
 * installer's profile snippet. Lifted verbatim from the legacy hardcoded
 * init script.
 *
 * `user` is interpolated directly — caller has already validated it via
 * {@link assertSafeShellIdent}.
 */
function miseBootstrapScript(user: string): string {
  return `# mise plugin: install mise into <user>'s ~/.local/bin via sudo -iu.
sudo -iu ${user} bash -lc 'curl -fsSL https://mise.run | sh'`;
}

/**
 * Expand a mise plugin. Contributes proxy domains for mise itself and
 * common language CDNs, plus a pre-lockdown bootstrap snippet that installs
 * mise. No post-lockdown commands or proxy actions.
 */
export function expandMise(
  _plugin: MisePlugin,
  ctx: PluginExpansionContext,
): ExpandedPlugin {
  assertSafeShellIdent('user', ctx.user);
  return {
    domains: [...MISE_DOMAINS],
    policies: [],
    commands: [],
    bootstrapScript: miseBootstrapScript(ctx.user),
  };
}
