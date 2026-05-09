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

/** Path to the per-project sandbox manifest, relative to a project dir. */
export function sandboxConfigPath(projectDir: string): string {
  return path.join(projectDir, '.aurica', 'sandbox.json');
}
