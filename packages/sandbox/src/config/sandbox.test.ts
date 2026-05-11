import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSandboxConfig } from './sandbox.js';

/**
 * Write a `.aurica/sandbox.json` under a fresh temp directory and return
 * the directory path so the caller can pass it to `loadSandboxConfig`.
 */
async function writeFixture(config: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'aurica-sandbox-config-test-'),
  );
  await fs.mkdir(path.join(dir, '.aurica'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.aurica', 'sandbox.json'),
    JSON.stringify(config),
  );
  return dir;
}

describe('loadSandboxConfig — cross-field invariants', () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    tmpDirs = [];
  });

  afterEach(async () => {
    for (const d of tmpDirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('rejects tokenSource: gh-token combined with api: true', async () => {
    const dir = await writeFixture({
      name: 'test',
      plugins: {
        github: {
          username: 'u',
          repositories: [{ name: 'a/b' }],
          tokenSource: 'gh-token',
          api: true,
        },
      },
    });
    tmpDirs.push(dir);

    await expect(loadSandboxConfig(dir)).rejects.toThrow(
      /gh-token.*cannot be combined with `api: true`/,
    );
  });

  it('accepts tokenSource: gh-token without api', async () => {
    const dir = await writeFixture({
      name: 'test',
      plugins: {
        github: {
          username: 'u',
          repositories: [{ name: 'a/b' }],
          tokenSource: 'gh-token',
        },
      },
    });
    tmpDirs.push(dir);

    const config = await loadSandboxConfig(dir);
    expect(config.plugins.github).toMatchObject({
      tokenSource: 'gh-token',
    });
  });

  it('accepts tokenSource: env:VAR combined with api: true', async () => {
    const dir = await writeFixture({
      name: 'test',
      plugins: {
        github: {
          username: 'u',
          repositories: [{ name: 'a/b' }],
          tokenSource: 'env:GITHUB_TOKEN',
          api: true,
        },
      },
    });
    tmpDirs.push(dir);

    const config = await loadSandboxConfig(dir);
    expect(config.plugins.github).toMatchObject({
      tokenSource: 'env:GITHUB_TOKEN',
      api: true,
    });
  });

  it('rejects tokenSource that is not a parseable credential source', async () => {
    const dir = await writeFixture({
      name: 'test',
      plugins: {
        github: {
          username: 'u',
          repositories: [{ name: 'a/b' }],
          tokenSource: ':not-valid',
        },
      },
    });
    tmpDirs.push(dir);

    await expect(loadSandboxConfig(dir)).rejects.toThrow(/scheme is empty/);
  });
});
