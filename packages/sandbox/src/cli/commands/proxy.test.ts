import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isPidAlive,
  ProxyNotRunningError,
  readState,
  withState,
} from '#src/state/index.js';

import { buildDaemonSpawn, ensureProxyRunning, runProxyStop } from './proxy.js';

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

  it('does not treat AURICA_NO_AUTOSTART=0 as opting out', async () => {
    // `=0` is falsey intent; it must NOT short-circuit to requireRunningProxy.
    // Record this (alive) process as the proxy so we exercise the live path
    // without spawning a real daemon.
    process.env.AURICA_NO_AUTOSTART = '0';
    await withState((state) => {
      state.proxy = {
        pid: process.pid,
        host: '127.0.0.1',
        port: 51_218,
        startedAt: '2026-01-01T00:00:00.000Z',
      };
    });
    const endpoint = await ensureProxyRunning();
    expect(endpoint.pid).toBe(process.pid);
  });
});

describe('runProxyStop', () => {
  let dir: string;
  const realHome = process.env.AURICA_HOME;
  const children: number[] = [];

  /** Spawn a detached node child and record it as `state.proxy`. */
  async function recordProxyChild(script: string): Promise<number> {
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error('failed to spawn test child');
    children.push(pid);
    await withState((state) => {
      state.proxy = {
        pid,
        host: '127.0.0.1',
        port: 51_219,
        startedAt: '2026-01-01T00:00:00.000Z',
      };
    });
    return pid;
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-stop-'));
    process.env.AURICA_HOME = dir;
  });

  afterEach(async () => {
    for (const pid of children) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    children.length = 0;
    if (realHome === undefined) delete process.env.AURICA_HOME;
    else process.env.AURICA_HOME = realHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('throws ProxyNotRunningError when no live proxy is recorded', async () => {
    await expect(runProxyStop()).rejects.toBeInstanceOf(ProxyNotRunningError);
  });

  it('reports a clean stop when the daemon exits on SIGTERM', async () => {
    // Default SIGTERM behavior terminates the child; runProxyStop sees the pid
    // die and returns without escalating.
    const pid = await recordProxyChild('setInterval(() => {}, 1000)');
    await runProxyStop();
    expect(isPidAlive(pid)).toBe(false);
  });

  it('escalates to SIGKILL and clears state when SIGTERM is ignored', async () => {
    // Child traps SIGTERM so the clean-stop poll times out; runProxyStop must
    // SIGKILL it and clear `state.proxy` (SIGKILL skips the daemon's own
    // clean-up path). The child touches `readyPath` only after its handler is
    // installed, and we wait for that before signalling — otherwise a SIGTERM
    // racing the handler registration would kill the child by default and we'd
    // exercise the clean path instead of escalation. Short timeout keeps it
    // fast.
    const readyPath = path.join(dir, 'child-ready');
    const pid = await recordProxyChild(
      `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, '1'); setInterval(() => {}, 1000)`,
    );
    const readyBy = Date.now() + 5000;
    while (Date.now() < readyBy) {
      try {
        await fs.access(readyPath);
        break;
      } catch {
        await delay(20);
      }
    }
    await runProxyStop({ timeoutMs: 300 });
    // Give the OS a moment to reap the killed process before probing.
    await delay(100);
    expect(isPidAlive(pid)).toBe(false);
    const state = await readState();
    expect(state.proxy).toBeNull();
  });
});
