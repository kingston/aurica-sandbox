import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConfigModule from '#src/config/index.js';
import {
  loadUserConfig,
  sandboxConfigSchema,
  type UserConfig,
} from '#src/config/index.js';

import { assembleInitConfig, runInit } from './init.js';

// Keep the real config module but stub `loadUserConfig` so tests don't read
// the host's `~/.aurica/sandbox/config.json`. Default: no per-plugin defaults.
vi.mock('#src/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    loadUserConfig: vi.fn<() => Promise<UserConfig>>(() =>
      Promise.resolve({
        credentialProviders: [{ provider: 'env' }],
        credentialCache: { idleTimeoutSeconds: 900 },
        plugins: {},
      } as UserConfig),
    ),
  };
});

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn<() => Promise<unknown>>(),
  confirm: vi.fn<() => Promise<unknown>>(),
  input: vi.fn<() => Promise<unknown>>(),
  select: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('#src/plugins/github/host-identity.js', () => ({
  readHostGitIdentity: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
  detectGithubRepo: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
}));

import { checkbox, confirm, input, select } from '@inquirer/prompts';

import {
  detectGithubRepo,
  readHostGitIdentity,
} from '#src/plugins/github/host-identity.js';

const checkboxMock = vi.mocked(checkbox);
const confirmMock = vi.mocked(confirm);
const inputMock = vi.mocked(input);
const selectMock = vi.mocked(select);
const detectRepoMock = vi.mocked(detectGithubRepo);
const readIdentityMock = vi.mocked(readHostGitIdentity);
const loadUserConfigMock = vi.mocked(loadUserConfig);

/**
 * Loose shape of an inquirer prompt mock — the real mocks have
 * prompt-specific generic signatures, so call sites cast through this.
 */
interface QueueableMock {
  mockImplementation: (fn: () => Promise<never>) => unknown;
}

/** Make a mock consume the queued answers, one per call, in order. */
function queue(mock: QueueableMock, answers: unknown[]): void {
  let i = 0;
  mock.mockImplementation(
    () => Promise.resolve(answers[i++]) as Promise<never>,
  );
}

describe('assembleInitConfig', () => {
  it('produces a config that validates against sandboxConfigSchema', () => {
    const assembled = assembleInitConfig('proj', {
      github: { repositories: [{ name: 'owner/repo' }] },
      docker: {},
    });
    const parsed = sandboxConfigSchema.parse(assembled);
    expect(parsed.name).toBe('proj');
    expect(parsed.proxy.domains).toEqual([]);
    expect(parsed.plugins.github).toEqual({
      repositories: [{ name: 'owner/repo' }],
    });
    expect(parsed.plugins.docker).toEqual({});
  });
});

describe('runInit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-init-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function readPlugins(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(
      path.join(dir, '.aurica', 'sandbox.json'),
      'utf8',
    );
    const config = JSON.parse(raw) as { plugins: Record<string, unknown> };
    return config.plugins;
  }

  it('writes a github + docker config from the prompt answers', async () => {
    checkboxMock.mockResolvedValue(['github', 'docker']);
    // No detected repo, so it's typed in. No user default → token is prompted.
    queue(inputMock as unknown as QueueableMock, ['acme/widgets']);
    selectMock.mockResolvedValue('gh-token');

    await runInit(dir);

    const plugins = await readPlugins();
    expect(plugins.github).toEqual({
      repositories: [{ name: 'acme/widgets' }],
      tokenSource: 'gh-token',
    });
    expect(plugins.docker).toEqual({});
  });

  it('does not prompt for API access and always offers gh-token', async () => {
    checkboxMock.mockResolvedValue(['github']);
    queue(inputMock as unknown as QueueableMock, ['acme/widgets']);
    selectMock.mockResolvedValue('gh-token');

    await runInit(dir);

    // API access is never asked about, so no confirm is shown for github.
    expect(confirmMock).not.toHaveBeenCalled();
    const tokenSelect = selectMock.mock.calls[0]?.[0] as unknown as {
      choices: { value: string }[];
    };
    expect(tokenSelect.choices.map((c) => c.value)).toContain('gh-token');

    const plugins = await readPlugins();
    expect(plugins.github).toEqual({
      repositories: [{ name: 'acme/widgets' }],
      tokenSource: 'gh-token',
    });
  });

  it('skips the token prompt when a user-level default token source exists', async () => {
    loadUserConfigMock.mockResolvedValueOnce({
      credentialProviders: [{ provider: 'env' }],
      credentialCache: { idleTimeoutSeconds: 900 },
      plugins: { github: { defaultTokenSource: 'env:GH_PAT' } },
    } as UserConfig);
    checkboxMock.mockResolvedValue(['github']);
    queue(inputMock as unknown as QueueableMock, ['acme/widgets']);

    await runInit(dir);

    // No token select is shown, and tokenSource is omitted so the config
    // inherits the user-level default at create time.
    expect(selectMock).not.toHaveBeenCalled();
    const plugins = await readPlugins();
    expect(plugins.github).toEqual({
      repositories: [{ name: 'acme/widgets' }],
    });
  });

  it('offers the detected repo as a yes/no and never writes the git identity', async () => {
    // A user default token source keeps the token prompt out of the way so
    // this test stays focused on repo detection + identity handling.
    loadUserConfigMock.mockResolvedValueOnce({
      credentialProviders: [{ provider: 'env' }],
      credentialCache: { idleTimeoutSeconds: 900 },
      plugins: { github: { defaultTokenSource: 'env:GH_PAT' } },
    } as UserConfig);
    checkboxMock.mockResolvedValue(['github']);
    detectRepoMock.mockResolvedValue('acme/widgets');
    // Even when the host identity is available, init must not bake it into the
    // committed config — it's resolved from the host at create time instead.
    readIdentityMock.mockResolvedValue({
      name: 'Ada',
      email: 'ada@example.com',
    });
    // Confirm "Clone acme/widgets?" (yes).
    queue(confirmMock as unknown as QueueableMock, [true]);

    await runInit(dir);

    // The detected repo drives the confirm; no free-text input is asked.
    const firstConfirm = confirmMock.mock.calls[0]?.[0] as { message: string };
    expect(firstConfirm.message).toBe('Clone acme/widgets?');
    expect(inputMock).not.toHaveBeenCalled();

    const plugins = await readPlugins();
    expect(plugins.github).toEqual({
      repositories: [{ name: 'acme/widgets' }],
    });
  });

  it('captures the claude-code auth mode', async () => {
    checkboxMock.mockResolvedValue(['claude-code']);
    selectMock.mockResolvedValue('subscription');
    inputMock.mockResolvedValue('');

    await runInit(dir);

    const plugins = await readPlugins();
    expect(plugins['claude-code']).toEqual({ authMode: 'subscription' });
  });

  it('refuses to overwrite an existing config without force', async () => {
    await fs.mkdir(path.join(dir, '.aurica'), { recursive: true });
    await fs.writeFile(path.join(dir, '.aurica', 'sandbox.json'), '{}');
    checkboxMock.mockResolvedValue([]);

    await expect(runInit(dir)).rejects.toThrow(/Refusing to overwrite/);
  });
});
