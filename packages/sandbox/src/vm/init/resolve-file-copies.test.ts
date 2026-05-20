import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveFileCopies } from './resolve-file-copies.js';

describe('resolveFileCopies', () => {
  let projectDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'aurica-resolve-test-'),
    );
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-resolve-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('returns an empty array when no entries are provided', async () => {
    expect(await resolveFileCopies(projectDir, [])).toEqual([]);
  });

  it('resolves a project-relative file as absolute and flags it as a file', async () => {
    await fs.writeFile(path.join(projectDir, '.env'), 'X=1\n');

    const [entry] = await resolveFileCopies(projectDir, [
      { src: '.env', dest: '.env' },
    ]);

    expect(entry).toEqual({
      absSrc: path.join(projectDir, '.env'),
      isFile: true,
      dest: '.env',
    });
  });

  it('resolves a project-relative directory and flags it as a directory', async () => {
    await fs.mkdir(path.join(projectDir, 'config'));
    await fs.writeFile(path.join(projectDir, 'config', 'a.toml'), '');

    const [entry] = await resolveFileCopies(projectDir, [
      { src: 'config', dest: 'config' },
    ]);

    expect(entry?.absSrc).toBe(path.join(projectDir, 'config'));
    expect(entry?.isFile).toBe(false);
  });

  it('expands ~/ in src against the host home', async () => {
    await fs.mkdir(path.join(fakeHome, '.claude'));
    await fs.mkdir(path.join(fakeHome, '.claude', 'skills'));

    const [entry] = await resolveFileCopies(projectDir, [
      { src: '~/.claude/skills', dest: '~/.claude/skills' },
    ]);

    expect(entry?.absSrc).toBe(path.join(fakeHome, '.claude', 'skills'));
    expect(entry?.isFile).toBe(false);
  });

  it('throws a clear error when src does not exist', async () => {
    await expect(
      resolveFileCopies(projectDir, [{ src: 'missing.env', dest: '.env' }]),
    ).rejects.toThrow(/missing\.env.*does not exist/);
  });

  it('preserves the original dest string verbatim', async () => {
    await fs.writeFile(path.join(projectDir, '.env'), '');
    const [entry] = await resolveFileCopies(projectDir, [
      { src: '.env', dest: '~/secrets/.env' },
    ]);
    expect(entry?.dest).toBe('~/secrets/.env');
  });

  it('processes entries in order', async () => {
    await fs.writeFile(path.join(projectDir, 'a'), '');
    await fs.writeFile(path.join(projectDir, 'b'), '');
    const result = await resolveFileCopies(projectDir, [
      { src: 'a', dest: 'a' },
      { src: 'b', dest: 'b' },
    ]);
    expect(result.map((e) => path.basename(e.absSrc))).toEqual(['a', 'b']);
  });
});
