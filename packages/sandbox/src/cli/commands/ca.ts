import { ensureCA } from '#src/proxy/index.js';

export async function runCa(): Promise<void> {
  const ca = await ensureCA();
  process.stdout.write(ca.certPem);
  if (!ca.certPem.endsWith('\n')) process.stdout.write('\n');
}
