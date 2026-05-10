import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

import type { DockerPlugin } from '../schema.js';
import type { ExpandedPlugin, PluginExpansionContext } from '../types.js';

/**
 * Hosts Docker reaches once the iptables lockdown is in place. The apt repo
 * (`download.docker.com`) is needed even though installation happens
 * pre-lockdown, because the proxy allowlist also gates that bootstrap step
 * — proxy env vars are exported into `/etc/environment` before the install
 * runs, so apt goes through the proxy. The Docker Hub triple lets
 * post-lockdown `docker pull` from the default registry succeed.
 */
const DOCKER_DOMAINS = [
  'download.docker.com',
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
] as const;

/**
 * Build the pre-lockdown shell snippet that installs Docker Engine from the
 * official Docker apt repo and adds `<user>` to the `docker` group. Lifted
 * verbatim from the legacy hardcoded init script.
 *
 * `user` is interpolated directly — caller has already validated it via
 * {@link assertSafeShellIdent}.
 */
function dockerBootstrapScript(user: string): string {
  return `# docker plugin: install Docker Engine from the official Docker apt repo.
#   Root-mode daemon; the user runs docker via group membership rather than
#   sudo. The whole VM is isolated, so root-mode is fine.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \\
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
ARCH=$(dpkg --print-architecture)
echo "deb [arch=\${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y --no-install-recommends \\
  docker-ce docker-ce-cli containerd.io \\
  docker-buildx-plugin docker-compose-plugin

usermod -aG docker ${user}`;
}

/**
 * Expand a docker plugin. Contributes proxy domains for the apt repo and
 * Docker Hub, plus a pre-lockdown bootstrap snippet that installs Docker.
 * No post-lockdown commands or proxy actions.
 */
export function expandDocker(
  _plugin: DockerPlugin,
  ctx: PluginExpansionContext,
): ExpandedPlugin {
  assertSafeShellIdent('user', ctx.user);
  return {
    domains: [...DOCKER_DOMAINS],
    policies: [],
    commands: [],
    bootstrapScript: dockerBootstrapScript(ctx.user),
  };
}
