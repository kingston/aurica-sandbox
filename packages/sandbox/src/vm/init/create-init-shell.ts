import { assertSafeShellIdent } from '#src/utils/shell-safety.js';

/**
 * Options for {@link createInitShell}. All fields are required because the
 * generated script embeds them directly; defaults belong to the caller (the
 * provider-specific delivery wrapper), not to this generator.
 */
export interface InitShellOptions {
  /**
   * Linux username inside the VM. Validated to be a safe shell identifier
   * before interpolation. Plugin bootstrap snippets that need the user name
   * receive it via the plugin expansion context, not through this script.
   */
  user: string;
  /**
   * Hostname (resolvable inside the VM) for the local proxy. e.g.
   * `host.orb.internal` for OrbStack, `host.lima.internal` for Lima.
   */
  proxyHost: string;
  /** TCP port the proxy listens on. */
  proxyPort: number;
  /**
   * Pre-lockdown shell snippet contributed by the project's plugins. Runs
   * as root with the network open, between base apt packages and the
   * iptables lockdown. Empty string when no plugin contributed one.
   *
   * Trusted code (it ships in the sandbox tool's source). The caller is
   * responsible for validating any inputs interpolated into the snippet.
   */
  pluginBootstrap: string;
}

/**
 * Build a `#!/bin/bash` bootstrap script that, when run as root on a fresh
 * Ubuntu VM, will:
 *
 *  1. apt-install baseline tools (git, iptables, iptables-persistent,
 *     ca-certificates, curl, sudo, gnupg)
 *  2. run the plugin bootstrap snippet (e.g. install Docker, install mise) —
 *     skipped cleanly when empty
 *  3. write `/etc/environment` with `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
 *     pointing at the host proxy, so post-lockdown shells (started by
 *     `orbctl run` etc.) inherit the proxy via PAM
 *  4. apply a `DROP`-by-default `OUTPUT` policy on both `iptables` (IPv4)
 *     and `ip6tables` (IPv6) that allows only `lo`, `ESTABLISHED`/`RELATED`,
 *     DNS (udp/tcp 53), and tcp/`<proxyPort>` to `<proxyHost>`. The proxy
 *     IP is pinned at boot via `getent ahosts`, and the proxy-allow rule is
 *     applied to the matching family (IPv4 or IPv6) — both stacks are
 *     locked down regardless, so the VM cannot escape the proxy via
 *     whichever family wasn't resolved. A terminal `REJECT` rule with
 *     `icmp-admin-prohibited` (and the IPv6 equivalent) is appended after
 *     the DROP policy so disallowed traffic fails fast with a clear
 *     `EACCES` instead of hanging until connect timeout.
 *  5. persist the rules via `iptables-save > /etc/iptables/rules.v4` and
 *     `ip6tables-save > /etc/iptables/rules.v6`
 *
 * **Order is load-bearing**: installs (base packages + plugin bootstrap)
 * happen with the network open, then iptables locks the VM down.
 * Reordering breaks installs.
 *
 * The script runs under `set -euo pipefail` with `IFS=$'\\n\\t'` and an `ERR`
 * trap that prints the failing command, line number, and exit code — so a
 * non-zero exit anywhere in the script surfaces a useful error instead of a
 * silent abort.
 *
 * The script is provider-agnostic. OrbStack's cloud-init `runcmd` and Lima's
 * `provision: { mode: system }` both invoke as root, which is what this
 * script expects. Currently Ubuntu-only.
 */
export function createInitShell(opts: InitShellOptions): string {
  assertSafeShellIdent('user', opts.user);
  assertSafeShellIdent('proxyHost', opts.proxyHost);
  if (
    !Number.isInteger(opts.proxyPort) ||
    opts.proxyPort <= 0 ||
    opts.proxyPort > 65_535
  ) {
    throw new Error(
      `proxyPort must be a TCP port in 1..65535, got ${opts.proxyPort}`,
    );
  }

  const { proxyHost, proxyPort, pluginBootstrap } = opts;

  const pluginSection = pluginBootstrap.trim()
    ? `\n# 2. Plugin bootstrap snippets. Run with the network still open;\n#    iptables lockdown comes last.\n${pluginBootstrap}\n`
    : '';

  return `#!/bin/bash
set -euo pipefail
IFS=$'\\n\\t'
trap 'echo "ERROR: \\"$BASH_COMMAND\\" failed at line $LINENO (exit $?)" >&2' ERR

export DEBIAN_FRONTEND=noninteractive

# 1. Base packages. Network must be open — iptables lockdown comes last.
apt-get update -y
apt-get install -y --no-install-recommends \\
  git iptables iptables-persistent ca-certificates curl sudo gnupg
${pluginSection}
# 3. Proxy env for post-lockdown shells. /etc/environment is read by PAM at
#    login, which is what 'orbctl run' triggers, so subsequent commands
#    (apt, git, mise install, pnpm) pick up the proxy without any extra
#    plumbing on the orchestrator side.
cat > /etc/environment <<EOF
HTTP_PROXY=http://${proxyHost}:${proxyPort}
HTTPS_PROXY=http://${proxyHost}:${proxyPort}
http_proxy=http://${proxyHost}:${proxyPort}
https_proxy=http://${proxyHost}:${proxyPort}
NO_PROXY=localhost,127.0.0.1,${proxyHost}
no_proxy=localhost,127.0.0.1,${proxyHost}
EOF

# 4. iptables: default DROP on OUTPUT for both IPv4 and IPv6, allow loopback,
#    established, DNS, and only the host proxy. Resolve the proxy hostname
#    now so the rule pins the IP rather than relying on DNS at packet time.
#    'getent ahosts' returns both families; pick the first and apply the
#    proxy-allow rule on the matching stack. The other stack is still
#    locked down so traffic cannot escape via the unresolved family.
PROXY_IP=$(getent ahosts ${proxyHost} | awk '{ print $1; exit }')
if [ -z "$PROXY_IP" ]; then
  echo "failed to resolve ${proxyHost}" >&2
  exit 1
fi

# Apply the same skeleton (flush, lo, established, DNS) on both stacks.
for ipt in iptables ip6tables; do
  $ipt -F OUTPUT
  $ipt -A OUTPUT -o lo -j ACCEPT
  $ipt -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  $ipt -A OUTPUT -p udp --dport 53 -j ACCEPT
  $ipt -A OUTPUT -p tcp --dport 53 -j ACCEPT
done

# Allow the proxy on whichever family resolved. ':' in the address means IPv6.
case "$PROXY_IP" in
  *:*) ip6tables -A OUTPUT -p tcp -d "$PROXY_IP" --dport ${proxyPort} -j ACCEPT ;;
  *)   iptables  -A OUTPUT -p tcp -d "$PROXY_IP" --dport ${proxyPort} -j ACCEPT ;;
esac

iptables  -P OUTPUT DROP
ip6tables -P OUTPUT DROP

# Surface a clear error on disallowed traffic instead of letting connects
# hang until timeout. Default policy is still DROP — this just makes the
# failure mode visible to the caller.
iptables  -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited

mkdir -p /etc/iptables
iptables-save  > /etc/iptables/rules.v4
ip6tables-save > /etc/iptables/rules.v6
`;
}
