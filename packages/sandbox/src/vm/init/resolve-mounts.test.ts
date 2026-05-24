import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatMountArg, resolveMounts } from './resolve-mounts.js';

describe('resolveMounts', () => {
  let projectDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'aurica-mounts-test-'),
    );
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-mounts-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('returns an empty array when no entries are provided', async () => {
    expect(await resolveMounts(projectDir, [])).toEqual([]);
  });

  it('resolves a project-relative directory and omits dest when unset', async () => {
    await fs.mkdir(path.join(projectDir, 'shared'));

    const [entry] = await resolveMounts(projectDir, [{ src: 'shared' }]);

    expect(entry).toEqual({ absSrc: path.join(projectDir, 'shared') });
  });

  it('expands ~/ in src against the host home', async () => {
    await fs.mkdir(path.join(fakeHome, 'datasets'));

    const [entry] = await resolveMounts(projectDir, [
      { src: '~/datasets', dest: '/mnt/datasets' },
    ]);

    expect(entry).toEqual({
      absSrc: path.join(fakeHome, 'datasets'),
      dest: '/mnt/datasets',
    });
  });

  it('passes through absolute src paths', async () => {
    const abs = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-mounts-abs-'));
    try {
      const [entry] = await resolveMounts(projectDir, [{ src: abs }]);
      expect(entry?.absSrc).toBe(abs);
    } finally {
      await fs.rm(abs, { recursive: true, force: true });
    }
  });

  it('throws a clear error when src does not exist', async () => {
    await expect(
      resolveMounts(projectDir, [{ src: 'missing-dir' }]),
    ).rejects.toThrow(/missing-dir.*does not exist/);
  });

  it('throws when src is a regular file, not a directory', async () => {
    await fs.writeFile(path.join(projectDir, 'a-file'), '');
    await expect(
      resolveMounts(projectDir, [{ src: 'a-file' }]),
    ).rejects.toThrow(/not a directory/);
  });

  it('throws when dest is a relative path', async () => {
    await fs.mkdir(path.join(projectDir, 'shared'));
    await expect(
      resolveMounts(projectDir, [{ src: 'shared', dest: 'relative/dest' }]),
    ).rejects.toThrow(/must be an absolute VM path/);
  });

  it('processes entries in order', async () => {
    await fs.mkdir(path.join(projectDir, 'a'));
    await fs.mkdir(path.join(projectDir, 'b'));

    const result = await resolveMounts(projectDir, [
      { src: 'a' },
      { src: 'b' },
    ]);

    expect(result.map((e) => path.basename(e.absSrc))).toEqual(['a', 'b']);
  });
});

describe('formatMountArg', () => {
  it('returns absSrc alone when dest is omitted', () => {
    expect(formatMountArg({ absSrc: '/host/shared' })).toBe('/host/shared');
  });

  it('returns absSrc:dest when dest is provided', () => {
    expect(
      formatMountArg({ absSrc: '/host/shared', dest: '/mnt/shared' }),
    ).toBe('/host/shared:/mnt/shared');
  });
});
