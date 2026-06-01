import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProxyNotRunningError, withState } from '#src/state/index.js';

import { buildDaemonSpawn, ensureProxyRunning } from './proxy.js';

describe('buildDaemonSpawn', () => {
  const realArgv = process.argv;
  const realExecArgv = process.execArgv;

  beforeEach(() => {
    process.argv = ['/usr/bin/node', '/app/bin/aurica-sandbox.js'];
    process.execArgv = ['--import', 'tsx'];
  });

  afterEach(() => {
    process.argv = realArgv;
    process.execArgv = realExecArgv;
  });

  it('re-execs the same CLI as `proxy run`, preserving loader flags', () => {
    const recipe = buildDaemonSpawn();
    expect(recipe.command).toBe('/usr/bin/node');
    expect(recipe.args).toEqual([
      '--import',
      'tsx',
      '/app/bin/aurica-sandbox.js',
      'proxy',
      'run',
    ]);
  });

  it('appends -v when verbose is set', () => {
    expect(buildDaemonSpawn({ verbose: true }).args).toContain('-v');
    expect(buildDaemonSpawn({ verbose: false }).args).not.toContain('-v');
  });

  it('detaches and inherits the current cwd and env', () => {
    const recipe = buildDaemonSpawn();
    expect(recipe.options.detached).toBe(true);
    expect(recipe.options.cwd).toBe(process.cwd());
    expect(recipe.options.env).toBe(process.env);
  });
});

describe('ensureProxyRunning', () => {
  let dir: string;
  const realHome = process.env.AURICA_HOME;
  const realNoAutostart = process.env.AURICA_NO_AUTOSTART;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-autostart-'));
    process.env.AURICA_HOME = dir;
    delete process.env.AURICA_NO_AUTOSTART;
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env.AURICA_HOME;
    else process.env.AURICA_HOME = realHome;
    if (realNoAutostart === undefined) delete process.env.AURICA_NO_AUTOSTART;
    else process.env.AURICA_NO_AUTOSTART = realNoAutostart;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the existing entry without spawning when a live proxy is recorded', async () => {
    // This test process is, by definition, alive — record it as the proxy.
    await withState((state) => {
      state.proxy = {
        pid: process.pid,
        host: '127.0.0.1',
        port: 51_217,
        startedAt: '2026-01-01T00:00:00.000Z',
      };
    });
    const endpoint = await ensureProxyRunning();
    expect(endpoint.pid).toBe(process.pid);
    expect(endpoint.port).toBe(51_217);
  });

  it('honors AURICA_NO_AUTOSTART by throwing instead of starting a daemon', async () => {
    process.env.AURICA_NO_AUTOSTART = '1';
    await expect(ensureProxyRunning()).rejects.toBeInstanceOf(
      ProxyNotRunningError,
    );
  });
});
