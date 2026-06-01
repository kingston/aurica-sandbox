import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemonSpawn } from './proxy.js';

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
