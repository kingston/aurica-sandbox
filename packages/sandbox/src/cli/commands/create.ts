import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import ora from 'ora';

import { loadSandboxConfig } from '#src/config/index.js';
import { logger } from '#src/logger.js';
import { deriveFromConfig } from '#src/proxy/derive-rules.js';
import { ensureCA } from '#src/proxy/index.js';
import {
  requireRunningProxy,
  signalProxyReload,
  withState,
} from '#src/state/index.js';
import { defaultProvider } from '#src/vm/index.js';
import { createInitShell } from '#src/vm/init/create-init-shell.js';
import { runInitPipeline } from '#src/vm/init/run-init.js';
import { waitForIp } from '#src/vm/wait-for-ip.js';

/**
 * Default VM name when the user doesn't pass one to `create`. Joins the
 * project directory's basename with the current git branch (slugged to
 * `[a-zA-Z0-9_-]`), or falls back to the basename alone if the directory
 * isn't a git repo or HEAD is detached.
 */
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
    await defaultProvider.infoVM(name);
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
    await defaultProvider.destroyVM(name);
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
 *   2. Create a bare `--isolated` VM via the active provider. If a VM
 *      with this name already exists, bail with a clear "use rebuild"
 *      message — adopting partially-initialized VMs is a footgun.
 *   3. Wait for the VM to acquire an IPv4.
 *   4. Run the layered init pipeline: built-in (base packages + plugin
 *      bootstrap snippets + iptables lockdown), then plugin commands,
 *      then user-level hooks from `~/.aurica/sandbox/init/`, then
 *      project-level hooks from `<projectDir>/.aurica/init/`. Output
 *      streams live to the terminal.
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
    await defaultProvider.createVM({ name });
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

  // Per-sandbox auth secret: baked directly into the artifacts plugins
  // install in the VM (e.g. the MCP gateway's bearer in `~/.claude.json`)
  // and stored on the sandbox's state entry so the gateway can verify
  // incoming requests. 32 bytes of entropy.
  const authSecret = randomBytes(32).toString('hex');

  // Plugin expansion. The full result is needed here for the in-VM
  // bootstrap (commands + bootstrapScript); the proxy re-derives just the
  // rules half from disk on every reload.
  const expanded = deriveFromConfig(config, {
    user: linuxUser,
    sandboxName: name,
    authSecret,
  });

  // Register the sandbox now (status: 'creating') and reload the proxy so
  // it picks up the new entry and starts watching the project's
  // sandbox.json. The proxy reads rules straight from that file, so we no
  // longer cache `domains`/`actions` in state.
  await withState((state) => {
    state.sandboxes[name] = {
      name,
      projectDir,
      status: 'creating',
      ip,
      createdAt: new Date().toISOString(),
      authSecret,
    };
  });
  await signalProxyReload();

  // Resolve the host address VMs should connect to in order to reach the
  // proxy. The proxy listens on all interfaces, but VMs must hit it on the
  // provider's bridge IP — `host.orb.internal` is NAT'd to `127.0.0.1` and
  // collapses every VM into one source IP, defeating the per-sandbox
  // allowlist.
  const bridge = await defaultProvider.discoverHostBridgeIp();
  // ensureCA is idempotent and the proxy already called it during boot —
  // this just reads the persisted PEM so we can install it in the VM trust
  // store. Required for HTTPS through the proxy to validate (mockttp MITMs
  // every HTTPS request).
  const ca = await ensureCA();

  const exec = defaultProvider.createExec(name, linuxUser);
  const builtinScript = createInitShell({
    user: linuxUser,
    proxyHost: bridge.ip,
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    providerBootstrap: defaultProvider.bootstrapScript,
    pluginBootstrap: expanded.bootstrapScript,
  });
  const userInitDir = await statDirOrNull(
    path.join(os.homedir(), '.aurica', 'sandbox', 'init'),
  );
  const projectInitDir = await statDirOrNull(
    path.join(projectDir, '.aurica', 'init'),
  );
  try {
    await runInitPipeline(exec, {
      user: linuxUser,
      builtinScript,
      userInitDir,
      projectInitDir,
      pluginCommands: expanded.commands,
      ...(expanded.projectInitCwdOverride !== undefined
        ? { projectInitCwdOverride: expanded.projectInitCwdOverride }
        : {}),
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
