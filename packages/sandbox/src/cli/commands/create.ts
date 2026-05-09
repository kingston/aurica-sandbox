import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import ora from 'ora';

import { loadSandboxConfig } from '#src/config/index.js';
import type { GitConfig, ProxyAction } from '#src/config/index.js';
import { logger } from '#src/logger.js';
import {
  expandPlugins,
  type GithubPlugin,
  type Plugin,
} from '#src/plugins/index.js';
import {
  requireRunningProxy,
  signalProxyReload,
  withState,
} from '#src/state/index.js';
import { orbProvider } from '#src/vm/index.js';
import { createInitShell } from '#src/vm/init/create-init-shell.js';
import {
  GIT_TOKEN_PLACEHOLDER,
  runInitPipeline,
} from '#src/vm/init/run-init.js';
import { createOrbExec } from '#src/vm/providers/orb/init.js';
import { waitForIp } from '#src/vm/wait-for-ip.js';

export async function defaultName(projectDir: string): Promise<string> {
  const folder = path.basename(projectDir);
  try {
    const { stdout } = await execa(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: projectDir },
    );
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') {
      return `${folder}-${branch.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
    }
  } catch {
    /* not a git repo; fall through */
  }
  return folder;
}

/**
 * Parse a github URL like `https://github.com/foo/bar` or
 * `https://github.com/foo/bar.git` into `{ owner, repo }`. Returns null for
 * any URL whose host isn't `github.com` or whose path doesn't have at least
 * two segments.
 */
function parseGithubRepoFromUrl(
  url: string,
): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return null;
  const segments = parsed.pathname.replace(/^\//, '').split('/');
  if (segments.length < 2) return null;
  const [owner, repoRaw] = segments;
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/, '');
  if (!repo) return null;
  return { owner, repo };
}

/**
 * Synthesize a github plugin from `config.git` when both URL and token
 * are set and the URL points at github.com. Returns null otherwise so the
 * caller falls back to host-only auth.
 */
export function githubPluginFromGitConfig(
  git: GitConfig | undefined,
): GithubPlugin | null {
  if (!git?.tokenSource) return null;
  const repo = parseGithubRepoFromUrl(git.url);
  if (!repo) return null;
  return {
    type: 'github',
    repositories: [{ name: `${repo.owner}/${repo.repo}` }],
    token: git.tokenSource,
  };
}

/**
 * Fallback host-level proxy action for non-github git URLs (gitlab,
 * bitbucket, self-hosted). Preserves pre-integrations behavior for hosts
 * with no provider yet.
 */
export function nonGithubGitAction(
  git: GitConfig | undefined,
): ProxyAction | null {
  if (!git?.tokenSource) return null;
  if (parseGithubRepoFromUrl(git.url)) return null;
  return {
    domain: new URL(git.url).host,
    hook: 'replaceApiKey',
    header: 'Authorization',
    placeholderValue: GIT_TOKEN_PLACEHOLDER,
    replacementValue: git.tokenSource,
  };
}

async function statDirOrNull(p: string): Promise<string | null> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Recognise orbctl's "machine already exists" error so we can surface a
 * clear adoption message instead of a generic failure. orbctl's exact
 * wording isn't part of any contract, so we match loosely on key tokens.
 */
function isAlreadyExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already.*exist|in use|exists/i.test(msg);
}

/**
 * Best-effort check for whether an OrbStack VM with this name already
 * exists. Treats any error from `infoVM` as "doesn't exist" — orbctl's
 * not-found error messages aren't a stable contract, and treating an
 * unrelated failure as "exists" would block a legitimate create.
 */
export async function vmExists(name: string): Promise<boolean> {
  try {
    await orbProvider.infoVM(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Destroy any existing OrbStack VM with this name and clear its state
 * entry. Used by `rebuild` (and other callers that want to ensure a
 * clean slate before `createVM`). No-ops if no VM exists.
 */
export async function destroyIfExists(name: string): Promise<void> {
  if (!(await vmExists(name))) return;
  const recreateSpinner = ora(`destroying existing VM ${name}`).start();
  try {
    await orbProvider.destroyVM(name);
    recreateSpinner.succeed(`destroyed existing VM ${name}`);
  } catch (err) {
    recreateSpinner.fail(`failed to destroy existing VM ${name}`);
    throw err;
  }
  await withState((state) => {
    if (name in state.sandboxes) {
      const next = { ...state.sandboxes };
      Reflect.deleteProperty(next, name);
      state.sandboxes = next;
    }
  });
}

/**
 * Create a fresh sandbox VM end-to-end:
 *
 *   1. Read `.aurica/sandbox.json` (with cross-field validation).
 *   2. Create a bare `--isolated` VM via `orbProvider.createVM`. If a VM
 *      with this name already exists, bail with a clear "use rebuild"
 *      message — adopting partially-initialized VMs is a footgun.
 *   3. Wait for the VM to acquire an IPv4.
 *   4. Run the layered init pipeline: built-in (base packages + plugin
 *      bootstrap snippets + iptables lockdown), then plugin commands,
 *      then optional git clone, then user-level hooks from
 *      `~/.aurica/sandbox/init/`, then project-level hooks from
 *      `<projectDir>/.aurica/init/`. Output streams live to the terminal.
 *   5. Register the sandbox in state with `status: 'running'` and reload
 *      the proxy so its allowlist + actions take effect.
 *
 * On init failure: record `status: 'failed-init'` and rethrow. The VM is
 * left in place for inspection; the caller can run `aurica-sandbox
 * rebuild <name>` to destroy and recreate.
 */
export async function runCreate(
  projectDir: string,
  nameArg: string | undefined,
): Promise<void> {
  // Fail fast if proxy isn't running.
  const proxy = await requireRunningProxy();

  const name = nameArg ?? (await defaultName(projectDir));
  const config = await loadSandboxConfig(projectDir);

  const createSpinner = ora(`creating VM ${name}`).start();
  try {
    await orbProvider.createVM({ name });
  } catch (err) {
    createSpinner.fail();
    if (isAlreadyExistsError(err)) {
      throw new Error(
        `VM ${name} already exists. Run \`aurica-sandbox rebuild ${name}\` to destroy and recreate it.`,
        { cause: err },
      );
    }
    throw err;
  }
  createSpinner.succeed(`created VM ${name}`);

  const ipSpinner = ora('waiting for IP').start();
  const vm = await waitForIp(name);
  const ip = vm.networkInfo?.ipV4 ?? null;
  if (ip) {
    ipSpinner.succeed(`got IP ${ip}`);
  } else {
    ipSpinner.fail('no IP after 30s');
    throw new Error(
      `VM ${name} did not acquire an IPv4 within 30 seconds; aborting init`,
    );
  }

  const linuxUser = process.env.USER ?? 'sandbox';

  // Desugar config.git into a synthetic github plugin when the git URL points
  // at github.com. Non-github hosts (gitlab, bitbucket) fall back to a
  // bespoke host-level action since there's no plugin provider for them.
  const syntheticGithubPlugin = githubPluginFromGitConfig(config.git);
  const fallbackGitAction = nonGithubGitAction(config.git);

  const allPlugins: Plugin[] = [
    ...config.plugins,
    ...(syntheticGithubPlugin ? [syntheticGithubPlugin] : []),
  ];
  const expanded = expandPlugins(allPlugins, { user: linuxUser });

  const allDomains = [...config.proxy.domains, ...expanded.domains];
  const allActions: ProxyAction[] = [
    ...config.proxy.actions,
    ...expanded.actions,
    ...(fallbackGitAction ? [fallbackGitAction] : []),
  ];

  // Register the sandbox now (status: 'creating') and reload the proxy so
  // its allowlist + the synthesized git action are live before init runs
  // — git clone in init goes through the proxy and needs both.
  await withState((state) => {
    state.sandboxes[name] = {
      name,
      projectDir,
      status: 'creating',
      domains: allDomains,
      actions: allActions,
      ip,
      createdAt: new Date().toISOString(),
    };
  });
  await signalProxyReload();

  // Resolve the host address VMs should connect to in order to reach the
  // proxy. The proxy listens on all interfaces, but VMs must hit it on the
  // provider's bridge IP — `host.orb.internal` is NAT'd to `127.0.0.1` and
  // collapses every VM into one source IP, defeating the per-sandbox
  // allowlist.
  const bridge = await orbProvider.discoverHostBridgeIp();

  const exec = createOrbExec(name, linuxUser);
  const builtinScript = createInitShell({
    user: linuxUser,
    proxyHost: bridge.ip,
    proxyPort: proxy.port,
    pluginBootstrap: expanded.bootstrapScript,
  });
  const userInitDir = await statDirOrNull(
    path.join(os.homedir(), '.aurica', 'sandbox', 'init'),
  );
  const projectInitDir = await statDirOrNull(
    path.join(projectDir, '.aurica', 'init'),
  );
  // Only attach the host-level placeholder when the fallback action is in
  // play (non-github tokenSource). When the synthetic github plugin covers
  // this URL, the github plugin's `commands` already supply a path-prefixed
  // `extraHeader` for the clone — emitting the host-level header too would
  // make git send duplicate `Authorization` headers.
  const needsHostLevelPlaceholder = fallbackGitAction !== null;
  const git = config.git
    ? {
        url: config.git.url,
        ...(config.git.ref !== undefined ? { ref: config.git.ref } : {}),
        ...(needsHostLevelPlaceholder
          ? { placeholder: GIT_TOKEN_PLACEHOLDER }
          : {}),
      }
    : null;

  try {
    await runInitPipeline(exec, {
      user: linuxUser,
      builtinScript,
      userInitDir,
      projectInitDir,
      git,
      pluginCommands: expanded.commands,
    });
  } catch (err) {
    await withState((state) => {
      const entry = state.sandboxes[name];
      if (entry) entry.status = 'failed-init';
    });
    throw err;
  }

  await withState((state) => {
    const entry = state.sandboxes[name];
    if (entry) entry.status = 'running';
  });
  await signalProxyReload();

  logger.log(
    JSON.stringify({ name, status: 'running', ip, projectDir }, null, 2),
  );
}
