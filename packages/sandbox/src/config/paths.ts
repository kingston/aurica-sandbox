import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the per-tool home directory for aurica-sandbox.
 *
 * Defaults to `~/.aurica/sandbox`. Override the parent via `AURICA_HOME` —
 * the `sandbox` segment is always appended so sibling Aurica tools can share
 * the same root (e.g. `AURICA_HOME=~/.aurica` → `~/.aurica/sandbox`).
 */
function auricaHome(): string {
  const base = process.env.AURICA_HOME ?? path.join(os.homedir(), '.aurica');
  return path.join(base, 'sandbox');
}

/** Path to the user-level config file. */
export function userConfigPath(): string {
  return path.join(auricaHome(), 'config.json');
}

/** Directory holding all user-level state for this tool. */
export function stateDir(): string {
  return auricaHome();
}

/** Path to the JSON file holding persistent runtime state. */
export function stateFilePath(): string {
  return path.join(stateDir(), 'state.json');
}

/**
 * Directory holding the host-global proxy response cache. Entries are keyed
 * by a hash of method + URL and shared across all sandboxes, so a download
 * pulled by one VM is served from disk to the next. No size cap or eviction
 * today — clear this directory manually to reclaim space.
 */
export function cacheDir(): string {
  return path.join(stateDir(), 'cache');
}

/** Path to the proxy daemon's log file. */
export function proxyLogPath(): string {
  return path.join(stateDir(), 'proxy.log');
}

/**
 * Path to the previous proxy log, kept by rotating {@link proxyLogPath} aside
 * on each daemon start so the prior run's output survives one restart.
 */
export function proxyLogRotatedPath(): string {
  return path.join(stateDir(), 'proxy.log.1');
}

/**
 * Path to the metadata half of the per-plugin credentials store. Holds
 * non-secret record fields keyed by namespace (e.g. `claude-code:oauth`,
 * `mcp:upstream:github`). The on-disk shape is `{ version: 2, records:
 * Record<string, unknown> }` — record contents are opaque to the store
 * itself; the record factory validates per-namespace.
 */
export function credentialsFilePath(): string {
  return path.join(stateDir(), 'credentials.json');
}

/**
 * Path to the secrets half of the per-plugin credentials store. Holds
 * only secret material (access tokens, refresh tokens, MCP SDK token
 * blobs) keyed by `<record-key>:<field>`. Always mode 0600 so a
 * `KeychainSecretVault` swap-in later only relocates the same logical
 * bytes off disk.
 */
export function secretsFilePath(): string {
  return path.join(stateDir(), 'secrets.json');
}

/** Path to the per-project sandbox manifest, relative to a project dir. */
export function sandboxConfigPath(projectDir: string): string {
  return path.join(projectDir, '.aurica', 'sandbox.json');
}

/** Path to the per-project env file, relative to a project dir. */
export function projectEnvPath(projectDir: string): string {
  return path.join(projectDir, '.aurica', '.env');
}
