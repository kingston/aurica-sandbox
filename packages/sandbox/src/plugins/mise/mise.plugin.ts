import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

import type { SandboxPlugin } from '../types.js';
import { miseProjectConfigSchema } from './schema.js';

/**
 * Hosts mise reaches both for its own install and for `mise install <tool>`
 * post-lockdown. `mise.en.dev` is the official apt repo and tarball mirror;
 * `mise.jdx.dev` / `mise-versions.jdx.dev` back `mise install`. The rest are
 * common language-runtime CDNs so pulling down Node, Python, Rust, Go etc.
 * works out of the box without each project having to enumerate them in
 * `proxy.domains`. Opinionated by design — anyone using mise is implicitly
 * asking for these.
 */
const MISE_DOMAINS = [
  'mise.en.dev',
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
 * Build the pre-lockdown shell snippet that installs mise from the official
 * `mise.en.dev/deb` apt repo and wires up the shell activation shims for
 * bash, zsh, and fish. Installing via apt puts the binary at `/usr/bin/mise`
 * so every shell (login or not) finds it on PATH — avoiding the
 * `~/.local/bin not on PATH` foot-gun of the `curl | sh` installer.
 *
 * Two complementary activations are installed for bash:
 *   - `~/.bash_profile` runs `mise activate bash --shims`, putting the shims
 *     directory on PATH for non-interactive login shells (e.g. `bash -l
 *     script.sh` used by hook scripts). The stock Ubuntu `~/.bashrc`
 *     interactivity guard would otherwise skip the activation below.
 *   - `~/.bashrc` runs full `mise activate bash` for interactive shells,
 *     adding env vars, hooks, and `cd`-based version switching on top of
 *     the shims.
 *
 * `~/.bash_profile` also sources `~/.profile` so the stock Ubuntu chain
 * (which sources `~/.bashrc` for interactive logins) is preserved — bash
 * skips `~/.profile` entirely when `~/.bash_profile` exists.
 *
 * Each rc-file edit is idempotent (`grep -qxF` guards the append), so
 * repeated bootstraps don't stack duplicates.
 *
 * `user` is interpolated directly — caller has already validated it via
 * {@link assertSafeShellIdent}.
 */
function miseBootstrapScript(user: string): string {
  // The shim heredoc runs as `<user>` via `sudo -iu`. A single-quoted
  // delimiter (`'MISE_SHIM_EOF'`) suppresses parameter expansion inside the
  // body, so `$HOME` / `$bash_line` / etc. are evaluated by the inner shell,
  // not by the outer init script.
  return `# mise plugin: install mise from the official apt repo, then inject
# the activation shim into bash/zsh/fish rc files. The shim blocks are
# appended idempotently so reruns don't stack duplicates.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mise.en.dev/gpg-key.pub \\
  -o /etc/apt/keyrings/mise-archive-keyring.asc
chmod a+r /etc/apt/keyrings/mise-archive-keyring.asc

echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.en.dev/deb stable main" \\
  > /etc/apt/sources.list.d/mise.list

apt-get update -y
apt-get install -y --no-install-recommends mise

sudo -iu ${user} bash -ls <<'MISE_SHIM_EOF'
bash_line='eval "$(mise activate bash)"'
grep -qxF "$bash_line" ~/.bashrc 2>/dev/null || echo "$bash_line" >> ~/.bashrc

# Non-interactive login shells (hook scripts run as \`bash -l script.sh\`)
# don't reach the interactivity-guarded ~/.bashrc, so put mise shims on
# PATH via ~/.bash_profile. Source ~/.profile first to preserve the
# Ubuntu chain (~/.profile sources ~/.bashrc for interactive logins) —
# bash skips ~/.profile entirely once ~/.bash_profile exists.
bash_profile="$HOME/.bash_profile"
touch "$bash_profile"
profile_source_line='[ -f ~/.profile ] && . ~/.profile'
grep -qxF "$profile_source_line" "$bash_profile" || echo "$profile_source_line" >> "$bash_profile"
shim_line='eval "$(mise activate bash --shims)"'
grep -qxF "$shim_line" "$bash_profile" || echo "$shim_line" >> "$bash_profile"

zsh_line='eval "$(mise activate zsh)"'
zsh_rc="\${ZDOTDIR-$HOME}/.zshrc"
touch "$zsh_rc"
grep -qxF "$zsh_line" "$zsh_rc" || echo "$zsh_line" >> "$zsh_rc"

fish_line='mise activate fish | source'
fish_rc="$HOME/.config/fish/config.fish"
mkdir -p "$(dirname "$fish_rc")"
touch "$fish_rc"
grep -qxF "$fish_line" "$fish_rc" || echo "$fish_line" >> "$fish_rc"
MISE_SHIM_EOF`;
}

/**
 * mise plugin. Contributes proxy domains for mise itself and common
 * language CDNs, plus a pre-lockdown bootstrap snippet that installs mise.
 * No post-lockdown commands or proxy actions.
 */
export const misePlugin: SandboxPlugin<
  undefined,
  typeof miseProjectConfigSchema
> = {
  name: 'mise',
  projectConfigSchema: miseProjectConfigSchema,
  userConfigSchema: undefined,
  initialize({ linuxUser }) {
    assertSafeShellIdent('linuxUser', linuxUser);
    return {
      domains: [...MISE_DOMAINS],
      policies: [],
      commands: [],
      bootstrapScript: miseBootstrapScript(linuxUser),
    };
  },
};
