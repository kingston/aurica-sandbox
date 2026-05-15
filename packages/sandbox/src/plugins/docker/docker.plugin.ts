import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

import type { PluginCommand, SandboxPlugin } from '../types.js';
import { dockerProjectConfigSchema } from './schema.js';

/**
 * Hosts Docker reaches once the iptables lockdown is in place. The apt repo
 * (`download.docker.com`) is needed even though installation happens
 * pre-lockdown, because the proxy allowlist also gates that bootstrap step
 * — proxy env vars are exported into `/etc/environment` before the install
 * runs, so apt goes through the proxy.
 *
 * The remaining hosts let post-lockdown `docker pull` from Docker Hub work:
 * registry+auth endpoints, the legacy Cloudflare blob CDN, and Docker's R2
 * bucket where image layers actually live today (the registry returns a
 * presigned R2 URL with an account-hash subdomain). The wildcard is scoped
 * to Docker's published R2 account hash so it doesn't open up arbitrary
 * Cloudflare buckets. See https://docs.docker.com/desktop/setup/allow-list/.
 */
const DOCKER_DOMAINS = [
  'download.docker.com',
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  '*.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com',
] as const;

/**
 * Build the pre-lockdown shell snippet that installs **rootless** Docker
 * Engine and sets it up as the sandbox user's systemd-user service.
 *
 * Rootless is chosen so container egress traverses the host's `OUTPUT`
 * chain (rootlesskit/slirp4netns translates container packets into ordinary
 * TCP sockets opened by the sandbox user in the host netns). That means
 * the firewall set up by `createInitShell` already covers container
 * traffic — no `PREROUTING` or `DOCKER-USER` rules needed — and
 * `docker network create` can't escape the proxy by making a new bridge.
 *
 * `user` is interpolated directly — caller has already validated it via
 * {@link assertSafeShellIdent}.
 */
function dockerBootstrapScript(user: string): string {
  return `# docker plugin: install rootless Docker Engine from the official Docker
#   apt repo and configure it as a systemd-user service for ${user}.
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
  docker-buildx-plugin docker-compose-plugin \\
  docker-ce-rootless-extras uidmap dbus-user-session slirp4netns

# Disable + mask the system-wide (rootful) dockerd; the rootless instance
# runs as the user's systemd unit instead. Masking prevents an apt upgrade
# from silently re-enabling it.
systemctl disable --now docker.service docker.socket || true
systemctl mask docker.service docker.socket

# Ensure subuid/subgid ranges exist for the user. \`useradd\` (used by some
# base images) doesn't populate these; only the \`adduser\` wrapper does. The
# setuptool aborts with "Missing system requirements" if they're absent.
# A single 65536-id block is the size suggested by Docker's docs and is
# enough for rootless containers.
if ! grep -q "^${user}:" /etc/subuid; then
  echo "${user}:100000:65536" >> /etc/subuid
fi
if ! grep -q "^${user}:" /etc/subgid; then
  echo "${user}:100000:65536" >> /etc/subgid
fi

# Prep XDG_RUNTIME_DIR so the user's systemd instance can start.
DOCKER_UID=$(id -u ${user})
install -d -o ${user} -g ${user} -m 0700 /run/user/\${DOCKER_UID}

# Enable linger so user@<uid>.service starts at boot without an SSH login.
loginctl enable-linger ${user}

# Run the rootless setuptool as the sandbox user. Idempotent — re-running
# is a no-op if the unit already exists.
sudo -u ${user} \\
  XDG_RUNTIME_DIR=/run/user/\${DOCKER_UID} \\
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/\${DOCKER_UID}/bus \\
  PATH=/usr/bin:/usr/local/bin:/usr/sbin \\
  dockerd-rootless-setuptool.sh install`;
}

/**
 * Append `DOCKER_HOST=unix:///run/user/<uid>/docker.sock` to
 * `/etc/environment` so every PAM-launched shell talks to the user's
 * rootless dockerd. Runs as root post-lockdown; `/etc/environment` was
 * created by the built-in init script in step 4.
 *
 * Idempotent: any prior `DOCKER_HOST=` line is removed before appending.
 * The username is passed as `$1` so it's never interpolated into the
 * script body.
 */
function etcEnvironmentDockerHostCommand(user: string): PluginCommand {
  return {
    user: 'root',
    argv: [
      'sh',
      '-c',
      [
        'sed -i "/^DOCKER_HOST=/d" /etc/environment',
        String.raw`printf "DOCKER_HOST=unix:///run/user/%s/docker.sock\n" "$(id -u "$1")" >> /etc/environment`,
      ].join(' && '),
      'sh',
      user,
    ],
  };
}

/**
 * Docker plugin. Installs rootless Docker Engine pre-lockdown as a
 * systemd-user service owned by the sandbox user. Contributes proxy
 * domains for the apt repo and Docker Hub so post-lockdown `docker pull`
 * works, plus a post-lockdown command that exports `DOCKER_HOST` into
 * `/etc/environment`.
 */
export const dockerPlugin: SandboxPlugin<
  undefined,
  typeof dockerProjectConfigSchema
> = {
  name: 'docker',
  projectConfigSchema: dockerProjectConfigSchema,
  userConfigSchema: undefined,
  initialize({ linuxUser }) {
    assertSafeShellIdent('linuxUser', linuxUser);
    return {
      domains: [...DOCKER_DOMAINS],
      policies: [],
      commands: [etcEnvironmentDockerHostCommand(linuxUser)],
      bootstrapScript: dockerBootstrapScript(linuxUser),
    };
  },
};
