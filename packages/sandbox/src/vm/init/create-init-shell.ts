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
   * Address of the host proxy as seen from inside the VM. For OrbStack this
   * must be the host's IPv4 on the machine bridge (e.g. `192.168.139.3`),
   * **not** `host.orb.internal`: OrbStack NATs the latter to `127.0.0.1` on
   * the host side, so every VM appears to the proxy with the same source
   * IP and the per-sandbox allowlist (keyed on `remoteIpAddress`) collapses.
   * Other providers (e.g. Lima with `host.lima.internal`) may pass a
   * hostname; this script just interpolates the value, so any IP literal
   * or DNS name that resolves inside the VM is acceptable.
   */
  proxyHost: string;
  /** TCP port the proxy listens on. */
  proxyPort: number;
  /**
   * PEM-encoded certificate for the host proxy's MITM CA (the same cert
   * `aurica-sandbox ca` prints). Installed into the VM's system trust store
   * so HTTPS requests through the proxy validate. Required because mockttp
   * MITMs every HTTPS request to apply the per-sandbox allowlist and
   * credential substitution; without trusting this CA, HTTPS in the VM
   * fails with `SSL certificate problem: self-signed certificate in
   * certificate chain`.
   *
   * Embedded inside a single-quoted heredoc, so no shell escaping is
   * needed; only a structural sanity check (PEM header) is enforced.
   */
  caCertPem: string;
  /**
   * Pre-lockdown shell snippet contributed by the VM provider (OrbStack,
   * Lima, …). Runs as root with the network open, right after base apt
   * packages and before any plugin bootstrap. Empty string when the
   * provider has nothing to contribute.
   *
   * Used for provider-specific quirks that don't belong in the
   * cross-provider init script — e.g. OrbStack ships
   * `/etc/sudoers.d/orbstack` granting passwordless sudo to the default
   * user, which the OrbStack provider removes here.
   *
   * Trusted code (it ships in the sandbox tool's source). The caller is
   * responsible for validating any inputs interpolated into the snippet.
   */
  providerBootstrap: string;
  /**
   * Pre-lockdown shell snippet contributed by the project's plugins. Runs
   * as root with the network open, after the provider bootstrap and
   * before the iptables lockdown. Empty string when no plugin contributed
   * one.
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
 *  2. run the provider bootstrap snippet (provider-specific quirks like
 *     OrbStack's passwordless-sudo removal) — skipped cleanly when empty
 *  3. run the plugin bootstrap snippet (e.g. install Docker, install mise) —
 *     skipped cleanly when empty
 *  4. install the proxy CA into `/usr/local/share/ca-certificates/` and run
 *     `update-ca-certificates`, so HTTPS requests MITM'd by the proxy
 *     validate against the VM's system trust store
 *  5. write `/etc/environment` with `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
 *     pointing at the host proxy, so post-lockdown shells (started by
 *     `orbctl run` etc.) inherit the proxy via PAM. Apps that honor these
 *     get a slightly faster forward-proxy path; apps that ignore them
 *     still go through the proxy via the DNAT in step 6.
 *  6. apply a `DROP`-by-default `OUTPUT` policy on both `iptables` (IPv4)
 *     and `ip6tables` (IPv6) that allows only `lo`, `ESTABLISHED`/`RELATED`,
 *     DNS (udp/tcp 53), and tcp/`<proxyPort>` to `<proxyHost>`. Transparent
 *     proxying is done with two NAT OUTPUT DNAT rules — tcp/80 and tcp/443
 *     are rewritten to the proxy IP:port, with a `! -d <proxyIP>` exception
 *     to prevent a NAT loop. mockttp on the host peeks the TLS ClientHello
 *     SNI (HTTPS) and the `Host:` header (HTTP) to recover the original
 *     destination hostname for the per-sandbox allowlist — no in-VM SNI
 *     shim needed. A terminal `REJECT` rule with `icmp-admin-prohibited`
 *     (and the IPv6 equivalent) makes disallowed traffic fail fast with
 *     a clear `EACCES` instead of hanging until connect timeout. The
 *     rules are persisted via `iptables-save > /etc/iptables/rules.v4`
 *     and `ip6tables-save > /etc/iptables/rules.v6`.
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
  // Cheap structural check — rejects empty / obviously-wrong inputs without
  // pulling in a full PEM parser. The body is interpolated into a
  // single-quoted heredoc so no escape-injection is possible regardless.
  if (!opts.caCertPem.startsWith('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      'caCertPem must be a PEM-encoded certificate starting with "-----BEGIN CERTIFICATE-----"',
    );
  }

  const {
    proxyHost,
    proxyPort,
    caCertPem,
    providerBootstrap,
    pluginBootstrap,
  } = opts;

  const providerSection = providerBootstrap.trim()
    ? `\n# 2. Provider bootstrap. Provider-specific quirks (e.g. OrbStack's\n#    passwordless-sudo removal) that don't belong in the cross-provider\n#    init script. Runs with the network still open, before plugins.\n${providerBootstrap}\n`
    : '';

  const pluginSection = pluginBootstrap.trim()
    ? `\n# 3. Plugin bootstrap snippets. Run with the network still open;\n#    iptables lockdown comes last.\n${pluginBootstrap}\n`
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

# Standard project workspace. Plugins that check out repos (today: github,
# when a repo has \`checkout: true\`) clone into \`/workspaces/<repo>\` as the
# default user, so the directory must exist and be writable before
# post-lockdown plugin commands fire. Idempotent: \`-p\` no-ops if the dir
# already exists, and re-chowning is harmless.
install -d -o ${opts.user} -g ${opts.user} -m 0755 /workspaces
${providerSection}${pluginSection}
# 4. Install the proxy CA so MITM'd HTTPS validates inside the VM. mockttp
#    intercepts every HTTPS request to apply the per-sandbox allowlist and
#    credential substitution; without trusting this CA, every HTTPS call
#    fails with a self-signed-cert error. Single-quoted heredoc terminator
#    suppresses parameter expansion inside the cert body.
cat > /usr/local/share/ca-certificates/aurica-sandbox.crt <<'EOF'
${caCertPem}
EOF
update-ca-certificates >/dev/null

# 5. Proxy env for post-lockdown shells. /etc/environment is read by PAM at
#    login, so subsequent commands (apt, git, mise install, pnpm) pick up
#    the proxy without any extra plumbing. Apps that honor these env vars
#    use a faster forward-proxy path; apps that ignore them are still
#    routed through the proxy by the DNAT rules in step 6 (mockttp peeks
#    SNI / Host header to recover the hostname for the allowlist).
#    NODE_EXTRA_CA_CERTS makes Node.js (and pkg-bundled binaries like
#    pnpm) trust the proxy CA in addition to its built-in roots, so
#    https registry fetches don't fail with "self-signed certificate in
#    certificate chain".
cat > /etc/environment <<EOF
HTTP_PROXY=http://${proxyHost}:${proxyPort}
HTTPS_PROXY=http://${proxyHost}:${proxyPort}
http_proxy=http://${proxyHost}:${proxyPort}
https_proxy=http://${proxyHost}:${proxyPort}
NO_PROXY=localhost,127.0.0.1,${proxyHost}
no_proxy=localhost,127.0.0.1,${proxyHost}
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aurica-sandbox.crt
EOF

# 6. iptables: default DROP on OUTPUT for both IPv4 and IPv6, allow loopback,
#    established, DNS, and the proxy IP:port. Transparent proxying is done
#    by DNAT'ing tcp/80 and tcp/443 to the proxy: mockttp natively handles
#    transparent traffic by peeking the TLS ClientHello SNI (HTTPS) and
#    the Host header (HTTP) to reconstruct the original destination — no
#    in-VM SNI shim needed. The '! -d <proxy>' exception prevents a NAT
#    loop on the proxy's own port. Resolve the proxy hostname now so the
#    rules pin the IP rather than relying on DNS at packet time. 'getent
#    ahosts' returns every address (both families); IPv4-literal callers
#    like OrbStack produce a single rule, hostname callers like Lima cover
#    both.
PROXY_IPS=$(getent ahosts ${proxyHost} | awk '{ print $1 }' | sort -u)
if [ -z "$PROXY_IPS" ]; then
  echo "failed to resolve ${proxyHost}" >&2
  exit 1
fi

# Expose the proxy's IPv4 to plugin and user init scripts via
# /etc/environment. Plugins that need to address the host (e.g. the MCP
# plugin's /etc/hosts entry for aurica.mcp.internal) read $AURICA_HOST_IP
# instead of re-resolving the proxy hostname themselves. Skipped on
# v6-only environments — the transparent NAT below is IPv4-only, so a
# v6-only host has no usable address from inside the VM.
PROXY_IPV4=$(printf '%s\\n' "$PROXY_IPS" | awk '!/:/ { print; exit }')
if [ -n "$PROXY_IPV4" ]; then
  echo "AURICA_HOST_IP=$PROXY_IPV4" >> /etc/environment
fi

# Apply the same skeleton (flush, lo, established, DNS) on both stacks.
for ipt in iptables ip6tables; do
  $ipt -F OUTPUT
  $ipt -A OUTPUT -o lo -j ACCEPT
  $ipt -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  $ipt -A OUTPUT -p udp --dport 53 -j ACCEPT
  $ipt -A OUTPUT -p tcp --dport 53 -j ACCEPT
done

# Allow outbound to the proxy on every resolved family. This covers both
# the env-var forward-proxy path (clients connect to <proxyIP>:<proxyPort>
# directly) and the DNAT'd transparent path (post-NAT, the destination is
# also <proxyIP>:<proxyPort>). Loop family-aware so hostname-passing
# providers (Lima) get covered too.
while IFS= read -r ip; do
  case "$ip" in
    *:*) ip6tables -A OUTPUT -p tcp -d "$ip" --dport ${proxyPort} -j ACCEPT ;;
    *)   iptables  -A OUTPUT -p tcp -d "$ip" --dport ${proxyPort} -j ACCEPT ;;
  esac
done <<< "$PROXY_IPS"

# Transparent NAT: rewrite tcp/80 and tcp/443 destinations to the proxy.
# The '! -d <proxyIP>' exception keeps proxy-bound traffic from being
# re-DNAT'd into itself. Only IPv4 here: OrbStack's bridge IP is IPv4,
# IPv6 stays default-DROP.
iptables -t nat -F OUTPUT
while IFS= read -r ip; do
  case "$ip" in
    *:*) ;;  # IPv6 — no transparent path; v6 traffic is DROPped by policy
    *)
      iptables -t nat -A OUTPUT -p tcp ! -d "$ip" --dport 80  -j DNAT --to-destination "$ip:${proxyPort}"
      iptables -t nat -A OUTPUT -p tcp ! -d "$ip" --dport 443 -j DNAT --to-destination "$ip:${proxyPort}"
      ;;
  esac
done <<< "$PROXY_IPS"

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
