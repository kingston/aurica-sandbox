import os from 'node:os';
import path from 'node:path';

import ora from 'ora';

import { logger } from '#src/logger.js';
import { signalProxyReload, withState } from '#src/state/index.js';
import type { State } from '#src/state/index.js';
import { statDirOrNull } from '#src/utils/path-exists.js';
import { defaultProvider } from '#src/vm/index.js';
import { runForkInitHooks } from '#src/vm/init/run-init.js';
import { assertPlatformSupported } from '#src/vm/platform.js';
import { waitForIp } from '#src/vm/wait-for-ip.js';

import { findPrimary } from './find-primary.js';
import { ensureProxyRunning } from './proxy.js';

/**
 * Pick the lowest unused 1-based concurrency index among existing forks of
 * the given primary. Gaps left by destroyed forks are reused.
 */
export function nextConcurrencyIndex(
  state: State,
  primaryName: string,
): number {
  const used = new Set(
    Object.values(state.sandboxes)
      .filter((e) => e.kind === 'fork' && e.parentName === primaryName)
      .map((e) => e.concurrencyIndex)
      .filter((i): i is number => i !== undefined),
  );
  let idx = 1;
  while (used.has(idx)) idx++;
  return idx;
}

/**
 * Clone the project's primary VM into a new running fork. The primary may be
 * running or stopped — the provider's clone snapshots the source and restores
 * it to its prior state, so forking never disturbs a running primary's session.
 *
 * Fast path — skips the full init pipeline. The fork inherits the primary's
 * entire disk state (OS, tools, proxy config, baked credentials) and its
 * `authSecret` so proxy placeholder tokens keep working without re-init.
 *
 * Steps:
 *   1. Find the primary for `projectDir` in state.
 *   2. Assign a `concurrencyIndex` (lowest unused positive integer among siblings).
 *   3. Clone the primary VM (the clone always starts stopped).
 *   4. Register fork in state, signal proxy.
 *   5. Start the clone and wait for its IP.
 *   6. Run `setup-fork.sh` hooks (user-level then project-level).
 *   7. Mark `status: 'running'` and signal proxy again.
 */
export async function runFork(
  projectDir: string,
  nameArg: string | undefined,
  { branch = '' }: { branch?: string } = {},
): Promise<void> {
  assertPlatformSupported();
  await ensureProxyRunning();

  const { result: prepResult } = await withState((state) => {
    const primary = findPrimary(state, projectDir);
    if (!primary) return null;

    const concurrencyIndex = nextConcurrencyIndex(state, primary.name);
    const forkName = nameArg ?? `${primary.name}-fork-${concurrencyIndex}`;

    if (forkName in state.sandboxes) {
      throw new Error(
        `A sandbox named ${forkName} already exists. Choose a different name.`,
      );
    }

    state.sandboxes[forkName] = {
      name: forkName,
      projectDir,
      status: 'creating',
      ip: null,
      createdAt: new Date().toISOString(),
      authSecret: primary.authSecret,
      kind: 'fork',
      parentName: primary.name,
      concurrencyIndex,
      // A fork is a CoW clone of the primary, so its in-VM checkout lives at
      // the same path; carry the primary's value rather than recomputing.
      ...(primary.vmProjectDir !== undefined
        ? { vmProjectDir: primary.vmProjectDir }
        : {}),
    };

    return { primaryName: primary.name, forkName, concurrencyIndex };
  });

  if (!prepResult) {
    throw new Error(
      `No primary sandbox found for ${projectDir}. Run \`aurica-sandbox create\` first.`,
    );
  }

  const { primaryName, forkName, concurrencyIndex } = prepResult;

  await signalProxyReload();

  const cloneSpinner = ora(
    `cloning primary ${primaryName} → ${forkName}`,
  ).start();
  try {
    await defaultProvider.cloneVM(primaryName, forkName);
    cloneSpinner.succeed(`cloned ${forkName}`);
  } catch (err) {
    cloneSpinner.fail();
    await withState((state) => {
      Reflect.deleteProperty(state.sandboxes, forkName);
    });
    throw err;
  }

  // From here on the fork VM exists; on any failure mark the entry
  // `failed-init` (mirroring `runCreate`) so `list` reflects reality rather
  // than leaving a ghost `creating` entry. The VM is left in place for
  // inspection.
  try {
    const startSpinner = ora(`starting fork ${forkName}`).start();
    try {
      await defaultProvider.startVM(forkName);
      startSpinner.succeed(`started fork ${forkName}`);
    } catch (err) {
      startSpinner.fail();
      throw err;
    }

    const ipSpinner = ora('waiting for IP').start();
    const vm = await waitForIp(forkName);
    const ip = vm.networkInfo?.ipV4 ?? null;
    if (ip) {
      ipSpinner.succeed(`got IP ${ip}`);
    } else {
      ipSpinner.fail('no IP after 30s');
      throw new Error(
        `Fork ${forkName} did not acquire an IPv4 within 30 seconds`,
      );
    }

    await withState((state) => {
      const entry = state.sandboxes[forkName];
      if (entry) entry.ip = ip;
    });
    await signalProxyReload();

    // Run fork init hooks. These are the only init scripts that run on a
    // fork — the full pipeline already ran on the primary and is inherited
    // via clone.
    const linuxUser = process.env.USER ?? 'sandbox';
    const userInitDir = await statDirOrNull(
      path.join(os.homedir(), '.aurica', 'sandbox', 'init'),
    );
    const projectInitDir = await statDirOrNull(
      path.join(projectDir, '.aurica', 'init'),
    );
    const exec = defaultProvider.createExec(forkName, linuxUser);
    await runForkInitHooks(exec, {
      user: linuxUser,
      forkName,
      primaryName,
      branch,
      concurrencyIndex,
      userInitDir,
      projectInitDir,
    });

    await withState((state) => {
      const entry = state.sandboxes[forkName];
      if (entry) entry.status = 'running';
    });
    await signalProxyReload();

    logger.log(
      JSON.stringify(
        {
          name: forkName,
          status: 'running',
          ip,
          parentName: primaryName,
          concurrencyIndex,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await withState((state) => {
      const entry = state.sandboxes[forkName];
      if (entry) entry.status = 'failed-init';
    });
    await signalProxyReload();
    throw err;
  }
}
