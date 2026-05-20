import { describe, expect, it } from 'vitest';

import type { VMExec } from '#src/vm/types.js';

import { pushFileCopies, resolveVmDest } from './push-file-copies.js';

interface PushCall {
  kind: 'pushFile' | 'pushDir';
  src: string;
  dest: string;
}

function makeRecordingExec(): { exec: VMExec; calls: PushCall[] } {
  const calls: PushCall[] = [];
  const exec: VMExec = {
    pushDir: (src, dest) => {
      calls.push({ kind: 'pushDir', src, dest });
      return Promise.resolve();
    },
    pushFile: (src, dest) => {
      calls.push({ kind: 'pushFile', src, dest });
      return Promise.resolve();
    },
    run: () => Promise.resolve(),
  };
  return { exec, calls };
}

describe('resolveVmDest', () => {
  it('anchors ~/ at /home/<user>', () => {
    expect(resolveVmDest('~/.env', 'sandbox', '/workspaces')).toBe(
      '/home/sandbox/.env',
    );
  });

  it('expands a bare ~ to the user home directory', () => {
    expect(resolveVmDest('~', 'sandbox', '/workspaces')).toBe('/home/sandbox');
  });

  it('resolves a relative dest against projectCwd', () => {
    expect(resolveVmDest('.env', 'sandbox', '/workspaces/foo')).toBe(
      '/workspaces/foo/.env',
    );
  });

  it('passes an absolute dest through unchanged', () => {
    expect(resolveVmDest('/etc/foo', 'sandbox', '/workspaces')).toBe(
      '/etc/foo',
    );
  });

  it('honors a github-plugin-style projectCwd override', () => {
    expect(resolveVmDest('config/.env', 'sandbox', '/workspaces/repo')).toBe(
      '/workspaces/repo/config/.env',
    );
  });
});

describe('pushFileCopies', () => {
  it('is a no-op for an empty list', async () => {
    const { exec, calls } = makeRecordingExec();
    await pushFileCopies(exec, 'sandbox', '/workspaces', []);
    expect(calls).toEqual([]);
  });

  it('dispatches files to pushFile and dirs to pushDir', async () => {
    const { exec, calls } = makeRecordingExec();
    await pushFileCopies(exec, 'sandbox', '/workspaces', [
      { absSrc: '/host/.env', isFile: true, dest: '.env' },
      {
        absSrc: '/host/skills',
        isFile: false,
        dest: '~/.claude/skills',
      },
    ]);

    expect(calls).toEqual([
      { kind: 'pushFile', src: '/host/.env', dest: '/workspaces/.env' },
      {
        kind: 'pushDir',
        src: '/host/skills',
        dest: '/home/sandbox/.claude/skills',
      },
    ]);
  });

  it('preserves entry order', async () => {
    const { exec, calls } = makeRecordingExec();
    await pushFileCopies(exec, 'sandbox', '/workspaces', [
      { absSrc: '/host/a', isFile: true, dest: 'a' },
      { absSrc: '/host/b', isFile: true, dest: 'b' },
      { absSrc: '/host/c', isFile: true, dest: 'c' },
    ]);
    expect(calls.map((c) => c.src)).toEqual(['/host/a', '/host/b', '/host/c']);
  });

  it('propagates a push failure', async () => {
    const exec: VMExec = {
      pushDir: () => Promise.resolve(),
      pushFile: () => Promise.reject(new Error('boom')),
      run: () => Promise.resolve(),
    };
    await expect(
      pushFileCopies(exec, 'sandbox', '/workspaces', [
        { absSrc: '/host/.env', isFile: true, dest: '.env' },
      ]),
    ).rejects.toThrow('boom');
  });
});
