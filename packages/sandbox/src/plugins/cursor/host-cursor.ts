import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Linux REH architectures Cursor publishes. Maps from Node's `process.arch`
 * (host-side) to the path segment used in
 * `https://downloads.cursor.com/production/<commit>/linux/<arch>/cursor-reh-linux-<arch>.tar.gz`.
 */
const ARCH_MAP: Readonly<Record<string, 'arm64' | 'x64'>> = {
  arm64: 'arm64',
  x64: 'x64',
};

/** Host-side detection result. */
export interface HostCursor {
  /** 40-char lowercase hex commit hash, validated. */
  commit: string;
  /** REH tarball arch segment that matches the host. */
  arch: 'arm64' | 'x64';
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Candidate paths to `Cursor.app/Contents/Resources/app/product.json` on
 * macOS. Probed in order; the first readable file wins. Exposed for tests.
 */
export function defaultProductJsonCandidates(): string[] {
  return [
    '/Applications/Cursor.app/Contents/Resources/app/product.json',
    path.join(
      os.homedir(),
      'Applications/Cursor.app/Contents/Resources/app/product.json',
    ),
  ];
}

/**
 * Best-effort lookup of the host machine's installed Cursor build. Returns
 * `null` on any failure: missing app, unreadable file, malformed JSON,
 * missing/invalid `commit`, or unsupported host arch. Callers treat `null`
 * as "skip pre-warm" — domain allowlisting alone keeps remote-SSH working.
 *
 * Synchronous because the plugin-expansion pipeline (`expandPlugins`) is
 * synchronous and runs on the host at sandbox-create / proxy-reload time —
 * a brief blocking read of a small JSON file is acceptable there.
 *
 * `candidates` and `hostArch` are injectable for unit tests; defaults read
 * the real filesystem and `process.arch`.
 */
export function readHostCursor(opts?: {
  candidates?: string[];
  hostArch?: string;
}): HostCursor | null {
  const arch = ARCH_MAP[opts?.hostArch ?? process.arch];
  if (!arch) return null;

  const candidates = opts?.candidates ?? defaultProductJsonCandidates();
  for (const file of candidates) {
    const commit = tryReadCommit(file);
    if (commit) return { commit, arch };
  }
  return null;
}

function tryReadCommit(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const commit = (parsed as { commit?: unknown }).commit;
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) return null;
  return commit;
}
