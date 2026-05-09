import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCA } from './ca.js';

describe('ensureCA', () => {
  let dir: string;
  let originalAuricaHome: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-ca-'));
    originalAuricaHome = process.env.AURICA_HOME;
    process.env.AURICA_HOME = dir;
  });

  afterEach(async () => {
    if (originalAuricaHome === undefined) delete process.env.AURICA_HOME;
    else process.env.AURICA_HOME = originalAuricaHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('generates and persists key + cert on first call', async () => {
    const ca = await ensureCA();
    expect(ca.certPem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    const onDisk = await fs.readFile(ca.certPath, 'utf8');
    expect(onDisk).toBe(ca.certPem);
  });

  it('is idempotent: second call returns the same cert without regenerating', async () => {
    const first = await ensureCA();
    const firstStat = await fs.stat(first.certPath);
    // Sleep just enough that mtime would change if the file were rewritten.
    await new Promise((r) => setTimeout(r, 10));
    const second = await ensureCA();
    const secondStat = await fs.stat(second.certPath);
    expect(second.certPem).toBe(first.certPem);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });
});
