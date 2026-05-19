/**
 * OrbStack-specific bootstrap snippet, injected as step 2 of the VM init
 * script (after base apt packages, before plugin bootstrap, before the
 * iptables lockdown).
 *
 * Currently does one thing: remove `/etc/sudoers.d/orbstack`, which
 * OrbStack ships with a passwordless-sudo rule for the default user.
 * Left in place, that rule would let any process inside the sandbox
 * escalate to root and tear down the iptables egress lockdown installed
 * at the end of the init script. Removing the file leaves the default
 * user with no sudoers entry at all — there is no in-VM path to root.
 * The host-side escape hatch (`orb -m <name> -u root`) is unaffected
 * and remains the only way for an operator to act as root.
 *
 * Guarded on file existence in case OrbStack ever stops shipping the
 * file or renames it.
 */
export const orbBootstrapScript = `if [ -f /etc/sudoers.d/orbstack ]; then
  rm -f /etc/sudoers.d/orbstack
fi
`;
