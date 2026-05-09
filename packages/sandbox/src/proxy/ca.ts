import fs from 'node:fs/promises';
import path from 'node:path';

import { generateCACertificate } from 'mockttp';

import { stateDir } from '#src/config/index.js';
import { pathExists } from '#src/utils/path-exists.js';

export interface CAFiles {
  keyPath: string;
  certPath: string;
  certPem: string;
}

function caDir(): string {
  return path.join(stateDir(), 'ca');
}

/**
 * Idempotent: returns the persisted CA, generating one on first call.
 *
 * The CA lives at `${stateDir()}/ca/{key.pem,cert.pem}` (chmod 0600). It's
 * reused across every `aurica-sandbox proxy` boot so guests with the cert
 * installed don't need to re-trust the proxy after a restart.
 */
export async function ensureCA(): Promise<CAFiles> {
  const dir = caDir();
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  await fs.mkdir(dir, { recursive: true });

  if ((await pathExists(keyPath)) && (await pathExists(certPath))) {
    const certPem = await fs.readFile(certPath, 'utf8');
    return { keyPath, certPath, certPem };
  }

  const generated = await generateCACertificate({
    subject: {
      commonName: 'Aurica Sandbox CA - DO NOT TRUST - TESTING ONLY',
      organizationName: 'Aurica',
    },
  });

  await fs.writeFile(keyPath, generated.key, { mode: 0o600 });
  await fs.writeFile(certPath, generated.cert, { mode: 0o600 });

  return { keyPath, certPath, certPem: generated.cert };
}
