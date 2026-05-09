import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GIT_TOKEN_PLACEHOLDER,
  type VMExec,
  runInitPipeline,
} from './run-init.js';

interface RecordedCall {
  kind: 'push' | 'run';
  /** push: localDir; run: argv joined */
  arg: string;
  /** run only */
  user?: 'root' | 'default';
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
    run: ({ user, argv }) => {
      calls.push({ kind: 'run', arg: argv.join(' '), user });
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

  it('runs only the built-in step when no hooks or git are configured', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\necho hi',
      userInitDir: null,
      projectInitDir: null,
      git: null,
    });
    const runs = calls.filter((c) => c.kind === 'run');
    expect(runs.map((r) => r.arg)).toEqual([
      'bash /home/sandbox/.aurica-init-staging/builtin/builtin.sh',
      'rm -rf /home/sandbox/.aurica-init-staging',
    ]);
    expect(runs[0]?.user).toBe('root');
  });

  it('configures git with the placeholder, never the resolved token', async () => {
    const { exec, calls } = makeFakeExec();
    const realToken = 'ghp_1234567890abcdef'; // must not appear in any call
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
      git: {
        url: 'https://github.com/foo/bar.git',
        placeholder: GIT_TOKEN_PLACEHOLDER,
      },
    });
    const runArgs = calls.filter((c) => c.kind === 'run').map((c) => c.arg);

    // Defense in depth: catches a regression where someone wires the resolved
    // token through this layer.
    for (const arg of runArgs) {
      expect(arg).not.toContain(realToken);
    }

    expect(runArgs).toContain(
      `git config --global http.https://github.com/.extraHeader Authorization: Bearer ${GIT_TOKEN_PLACEHOLDER}`,
    );
    expect(runArgs).toContain(
      'git clone https://github.com/foo/bar.git /home/sandbox/project',
    );
  });

  it('passes --branch when ref is set', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
      git: {
        url: 'https://github.com/foo/bar.git',
        ref: 'main',
        placeholder: GIT_TOKEN_PLACEHOLDER,
      },
    });
    const cloneCmd = calls.find(
      (c) => c.kind === 'run' && c.arg.startsWith('git clone'),
    );
    expect(cloneCmd?.arg).toBe(
      'git clone --branch main https://github.com/foo/bar.git /home/sandbox/project',
    );
  });

  it('skips a hook layer entirely when its dir is null', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
      git: null,
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
      git: null,
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
      git: null,
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

  it('runs both layers in built-in -> git -> user -> project order', async () => {
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
      git: {
        url: 'https://github.com/foo/bar.git',
        placeholder: GIT_TOKEN_PLACEHOLDER,
      },
    });

    const order = calls
      .filter((c) => c.kind === 'run')
      .map((c) => c.arg)
      .filter(
        (arg) =>
          arg.startsWith('bash ') ||
          arg.startsWith('git clone') ||
          arg.startsWith('git config'),
      );

    expect(order).toEqual([
      'bash /home/sandbox/.aurica-init-staging/builtin/builtin.sh',
      'git config --global http.https://github.com/.extraHeader Authorization: Bearer __AURICA_GIT_TOKEN__',
      'git clone https://github.com/foo/bar.git /home/sandbox/project',
      'bash /home/sandbox/.aurica-init-staging/user/setup-user.sh',
      'bash /home/sandbox/.aurica-init-staging/project/setup-root.sh',
    ]);
  });

  it('skips the host-level extraHeader when git.placeholder is undefined', async () => {
    // The github plugin is expected to provide a more-specific per-repo
    // extraHeader via pluginCommands; emitting the host-level one too
    // would produce duplicate Authorization headers on the wire.
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
      git: { url: 'https://github.com/foo/bar.git' },
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
      ],
    });
    const runArgs = calls.filter((c) => c.kind === 'run').map((c) => c.arg);
    expect(runArgs).not.toContain(
      `git config --global http.https://github.com/.extraHeader Authorization: Bearer ${GIT_TOKEN_PLACEHOLDER}`,
    );
    expect(runArgs).toContain(
      'git config --global http.https://github.com/foo/bar.extraHeader Authorization: Bearer __AURICA_TOKEN_TEST__',
    );
    expect(runArgs).toContain(
      'git clone https://github.com/foo/bar.git /home/sandbox/project',
    );
  });

  it('applies pluginCommands before the clone step with the requested user', async () => {
    const { exec, calls } = makeFakeExec();
    await runInitPipeline(exec, {
      user: 'sandbox',
      builtinScript: '#!/bin/bash\n:',
      userInitDir: null,
      projectInitDir: null,
      git: null,
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
        git: null,
      }),
    ).rejects.toThrow('boom');

    // Only the first run was attempted; cleanup wasn't reached.
    expect(runCount).toBe(1);
  });
});
