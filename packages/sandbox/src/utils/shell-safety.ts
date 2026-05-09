const SAFE_IDENT = /^[A-Za-z0-9._-]+$/;

/**
 * Throw if `value` contains characters that aren't safe to embed verbatim
 * into a shell script. Allowed: alphanumerics, `.`, `_`, `-`. Rejects
 * whitespace, shell metacharacters (`; & | $ \` etc.), and slashes.
 *
 * Use this on any string that will be interpolated into a shell snippet
 * (e.g. linux user names, hostnames) before letting the snippet execute.
 *
 * @param name human-readable label included in the thrown error
 * @param value the string to validate
 */
export function assertSafeShellIdent(name: string, value: string): void {
  if (!SAFE_IDENT.test(value)) {
    throw new Error(
      `${name} contains characters that aren't safe to embed in a shell script: ${JSON.stringify(value)}`,
    );
  }
}
