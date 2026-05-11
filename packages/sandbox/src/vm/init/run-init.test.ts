import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type VMExec, runInitPipeline } from './run-init.js';

interface RecordedCall {
  kind: 'push' | 'run';
  /** push: localDir; run: argv joined */
  arg: string;
  /** run only */
  user?: 'root' | 'default' | undefined;
  /** run only */
  cwd?: string | undefined;
}

function makeFakeExec(): {
  exec: VMExec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const exec: VMExec = {
    pushDir: (localDir, dest) => {
      calls.push({ kind: 'push', arg: `${localDir} -> ${dest}` });
      return Promise.resolve();
    },
    run: ({ user, argv, cwd }) => {
      calls.push({ kind: 'run', arg: argv.join(' '), user, cwd });
      return Promise.resolve();
    },
  };
  return { exec, calls };
}

describe('runInitPipeline', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-init-test-'));
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('runs only the built-in step when no hooks are configured', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\necho hi',
      userInitDir: null,
      projectInitDir: null,
    });
    const runs = calls.filter((c) => c.kind === 'run');
    expect(runs.map((r) => r.arg)).toEqual([
      'bash /home/sandbox/.aurica-init-staging/builtin/builtin.sh',
      'rm -rf /home/sandbox/.aurica-init-staging',
    ]);
    expect(runs[0]?.user).toBe('root');
  });

  it('skips a hook layer entirely when its dir is null', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
    });
    const userOrProjectPushes = calls.filter(
      (c) => c.kind === 'push' && /staging\/(user|project)$/.test(c.arg),
    );
    expect(userOrProjectPushes).toHaveLength(0);
  });

  it('skips a hook layer when neither setup script is present', async () => {
    const dir = path.join(workdir, 'empty-init');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'README.md'), 'not a setup script');

    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: dir,
      projectInitDir: null,
    });
    const userPushes = calls.filter(
      (c) =>
        c.kind === 'push' && c.arg.includes('-> .aurica-init-staging/user'),
    );
    expect(userPushes).toHaveLength(0);
  });

  it('runs only setup-root.sh when setup-user.sh is missing', async () => {
    const dir = path.join(workdir, 'init-root-only');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'setup-root.sh'), '#!/bin/bash\n:');

    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: dir,
      projectInitDir: null,
    });
    const layerRuns = calls.filter(
      (c) => c.kind === 'run' && c.arg.includes('staging/user'),
    );
    expect(layerRuns).toHaveLength(1);
    expect(layerRuns[0]?.user).toBe('root');
    expect(layerRuns[0]?.arg).toBe(
      'bash /home/sandbox/.aurica-init-staging/user/setup-root.sh',
    );
  });

  it('runs both layers in built-in -> user -> project order', async () => {
    const userDir = path.join(workdir, 'user-init');
    const projectDir = path.join(workdir, 'project-init');
    await fs.mkdir(userDir);
    await fs.mkdir(projectDir);
    await fs.writeFile(path.join(userDir, 'setup-user.sh'), '#!/bin/bash\n:');
    await fs.writeFile(
      path.join(projectDir, 'setup-root.sh'),
      '#!/bin/bash\n:',
    );

    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: userDir,
      projectInitDir: projectDir,
    });

    const order = calls
      .filter((c) => c.kind === 'run')
      .map((c) => c.arg)
      .filter((arg) => arg.startsWith('bash '));

    expect(order).toEqual([
      'bash /home/sandbox/.aurica-init-staging/builtin/builtin.sh',
      'bash /home/sandbox/.aurica-init-staging/user/setup-user.sh',
      'bash /home/sandbox/.aurica-init-staging/project/setup-root.sh',
    ]);
  });

  it('applies pluginCommands after built-in with the requested user', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
      pluginCommands: [
        {
          user: 'default',
          argv: [
            'git',
            'config',
            '--global',
            'http.https://github.com/foo/bar.extraHeader',
            'Authorization: Bearer __AURICA_TOKEN_TEST__',
          ],
        },
        {
          user: 'root',
          argv: ['apt-get', 'install', '-y', 'jq'],
        },
      ],
    });
    const runs = calls.filter((c) => c.kind === 'run');
    const headerCmd = runs.find((c) =>
      c.arg.startsWith('git config --global http.https://github.com/foo/bar'),
    );
    const aptCmd = runs.find((c) => c.arg === 'apt-get install -y jq');
    expect(headerCmd?.user).toBe('default');
    expect(aptCmd?.user).toBe('root');
  });

  it('runs setup-user.sh as a bare bash invocation regardless of projectInitCwdOverride', async () => {
    const dir = path.join(workdir, 'init-user-bare');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'setup-user.sh'), '#!/bin/bash\n:');

    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: dir,
      projectInitDir: null,
      // Set even though there is no setup-project.sh — must not affect
      // setup-user.sh, which stays at the default $HOME cwd.
      projectInitCwdOverride: '/workspaces/bar',
    });

    const runs = calls.filter((c) => c.kind === 'run');
    const userHook = runs.find((c) => c.arg.includes('setup-user.sh'));
    expect(userHook?.user).toBe('default');
    expect(userHook?.arg).toBe(
      'bash /home/sandbox/.aurica-init-staging/user/setup-user.sh',
    );
  });

  it('runs setup-project.sh in the project cwd when projectInitCwdOverride is provided', async () => {
    const dir = path.join(workdir, 'init-project-hook');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'setup-project.sh'), '#!/bin/bash\n:');
    await fs.writeFile(path.join(dir, 'setup-user.sh'), '#!/bin/bash\n:');
    await fs.writeFile(path.join(dir, 'setup-root.sh'), '#!/bin/bash\n:');

    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: dir,
      projectInitDir: null,
      projectInitCwdOverride: '/workspaces/bar',
    });

    const runs = calls.filter((c) => c.kind === 'run');
    const projectHook = runs.find((c) => c.arg.includes('setup-project.sh'));
    if (!projectHook) throw new Error('expected setup-project.sh run');
    expect(projectHook.user).toBe('default');
    // Provider runs the script directly with cwd set via the `run.cwd`
    // option (orbctl `-w`). No `bash -c` wrapper and no `env` prefix —
    // project env vars come from /etc/environment.
    expect(projectHook.cwd).toBe('/workspaces/bar');
    expect(projectHook.arg).toBe(
      'bash /home/sandbox/.aurica-init-staging/user/setup-project.sh',
    );

    // setup-root.sh / setup-user.sh are unchanged by the project context.
    const rootHook = runs.find((c) => c.arg.includes('setup-root.sh'));
    expect(rootHook?.user).toBe('root');
    expect(rootHook?.arg).toBe(
      'bash /home/sandbox/.aurica-init-staging/user/setup-root.sh',
    );
    const userHook = runs.find((c) => c.arg.includes('setup-user.sh'));
    expect(userHook?.arg).toBe(
      'bash /home/sandbox/.aurica-init-staging/user/setup-user.sh',
    );
  });

  it('runs setup-project.sh in /workspaces when no projectInitCwdOverride is provided', async () => {
    const dir = path.join(workdir, 'init-project-default-cwd');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'setup-project.sh'), '#!/bin/bash\n:');
    await fs.writeFile(path.join(dir, 'setup-user.sh'), '#!/bin/bash\n:');

    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: dir,
      projectInitDir: null,
    });

    const runs = calls.filter((c) => c.kind === 'run');
    const projectHook = runs.find((c) => c.arg.includes('setup-project.sh'));
    if (!projectHook) throw new Error('expected setup-project.sh run');
    expect(projectHook.user).toBe('default');
    expect(projectHook.cwd).toBe('/workspaces');
    expect(projectHook.arg).toBe(
      'bash /home/sandbox/.aurica-init-staging/user/setup-project.sh',
    );
    expect(runs.some((c) => c.arg.includes('setup-user.sh'))).toBe(true);
  });

  it('aborts on first non-zero exit', async () => {
    const calls: RecordedCall[] = [];
    let runCount = 0;
    const exec: VMExec = {
      pushDir: () => {
        calls.push({ kind: 'push', arg: '' });
        return Promise.resolve();
      },
      run: ({ argv }) => {
        runCount += 1;
        calls.push({ kind: 'run', arg: argv.join(' ') });
        if (runCount === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve();
      },
    };

    await expect(
      runInitPipeline(exec, {
        user: 'sandbox',
        builtinScript: '#!/bin/bash\n:',
        userInitDir: null,
        projectInitDir: null,
      }),
    ).rejects.toThrow('boom');

    // Only the first run was attempted; cleanup wasn't reached.
    expect(runCount).toBe(1);
  });
});
