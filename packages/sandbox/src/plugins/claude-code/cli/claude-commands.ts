import type { Command } from 'commander';

import { defaultCredentialStore } from '#src/credentials/credential-store.js';
import { logger } from '#src/logger.js';
import { signalProxyReload } from '#src/state/signal.js';

import { claudeRecord } from '../oauth.js';

/**
 * `aurica-sandbox claude login` — stub. Login now happens inside the
 * sandbox VM via `claude /login`; the proxy intercepts the resulting
 * token-endpoint response and persists tokens to the host store. No
 * host PKCE flow to drive here anymore.
 */
export function runClaudeLogin(): void {
  logger.info(
    'aurica-sandbox claude login: no host-side login needed. Run `claude /login` inside your sandbox VM — the proxy will capture the issued tokens.',
  );
}

/**
 * `aurica-sandbox claude status` — report whether a Claude OAuth slot
 * is present, and when the upstream-issued token actually expires
 * (independent of the far-future placeholder Claude Code on the guest
 * sees in its `~/.claude/.credentials.json`).
 */
export async function runClaudeStatus(): Promise<void> {
  const slot = await defaultCredentialStore.read(claudeRecord);
  if (!slot) {
    logger.info(
      'Claude Code: not logged in. Run `claude /login` inside your sandbox VM to authenticate.',
    );
    return;
  }
  const expiresAt = new Date(slot.expiresAt);
  const expired = slot.expiresAt <= Date.now();
  const scopes = slot.scopes.length > 0 ? slot.scopes.join(' ') : '<none>';
  const subscriptionType =
    typeof slot.extras.subscriptionType === 'string'
      ? slot.extras.subscriptionType
      : undefined;
  const tier = subscriptionType ? ` tier=${subscriptionType}` : '';
  logger.info(
    `Claude Code: logged in (token ${expired ? 'expired' : 'expires'} ${expiresAt.toISOString()}, scopes: ${scopes}${tier}).`,
  );
}

/**
 * `aurica-sandbox claude logout` — delete the cached Claude OAuth slot
 * (both metadata + secret halves). Does NOT touch the in-VM
 * `.credentials.json`; its placeholders are harmless without a slot to
 * resolve against (next sandbox request hits 401, user reruns
 * `claude /login`).
 */
export async function runClaudeLogout(): Promise<void> {
  const existed = await defaultCredentialStore.delete(claudeRecord);
  if (existed) {
    logger.info('Claude Code: credentials cleared.');
    await signalProxyReload();
  } else {
    logger.info('Claude Code: no cached credentials.');
  }
}

/**
 * Attach the `claude` subcommand group to a Commander root program.
 * Called by the `claude-code` plugin's `cliCommands` hook.
 */
export function registerClaudeCommands(program: Command): void {
  const claude = program
    .command('claude')
    .description(
      'manage Claude Code subscription credentials captured from sandbox `/login` flows',
    );

  claude
    .command('login')
    .description(
      'explain how to log in (login itself runs inside the sandbox VM)',
    )
    .action(() => {
      runClaudeLogin();
    });

  claude
    .command('status')
    .description(
      'report whether a Claude OAuth token is cached and when it expires',
    )
    .action(async () => {
      await runClaudeStatus();
    });

  claude
    .command('logout')
    .description('clear the cached Claude OAuth token')
    .action(async () => {
      await runClaudeLogout();
    });
}
