import fs from 'node:fs/promises';
import path from 'node:path';

import { checkbox } from '@inquirer/prompts';

import {
  defaultSandboxConfig,
  loadUserConfig,
  sandboxConfigPath,
  sandboxConfigSchema,
  userConfigPath,
} from '#src/config/index.js';
import { logger } from '#src/logger.js';
import { PLUGINS } from '#src/plugins/index.js';

/**
 * Assemble a project config from the chosen plugin blocks. Pure so it can be
 * unit-tested without prompting: defaults come from
 * {@link defaultSandboxConfig}, the proxy starts with no domains (plugins
 * contribute their own at `initialize`), and `plugins` is the keyed block map.
 */
export function assembleInitConfig(
  name: string,
  pluginBlocks: Record<string, unknown>,
): unknown {
  return {
    ...defaultSandboxConfig(name),
    proxy: { domains: [], policies: [] },
    plugins: pluginBlocks,
  };
}

/**
 * Interactively scaffold `.aurica/sandbox.json` for `projectDir`.
 *
 * Prompts for which plugins to enable, then lets each selected plugin gather
 * its own project-config block via `promptProjectConfig`. The assembled config
 * is validated against `sandboxConfigSchema` before being written, so an
 * invalid block fails fast. Refuses to overwrite an existing config unless
 * `force` is set.
 */
export async function runInit(
  projectDir: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const configPath = sandboxConfigPath(projectDir);
  let exists = false;
  try {
    await fs.access(configPath);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (exists && !force) {
    throw new Error(
      `Refusing to overwrite existing config at ${configPath}. Pass --force to overwrite.`,
    );
  }

  // Pad the plugin name so the inline descriptions line up in a column.
  const nameWidth = Math.max(...PLUGINS.map((p) => p.name.length));
  const selected = await checkbox<string>({
    message: 'Which plugins do you want to enable?',
    choices: PLUGINS.map((p) => ({
      name: p.description
        ? `${p.name.padEnd(nameWidth)}  ${p.description}`
        : p.name,
      // `short` is echoed in the submitted-answer summary, so keep it the bare
      // plugin name rather than the padded "name + description" label.
      short: p.name,
      value: p.name,
    })),
  });

  const pluginBlocks: Record<string, unknown> = {};
  // Iterate the registry (not the selection) so blocks are emitted in a
  // deterministic, registry-defined order.
  for (const plugin of PLUGINS) {
    if (!selected.includes(plugin.name)) continue;
    pluginBlocks[plugin.name] =
      (await plugin.promptProjectConfig?.({ projectDir, loadUserConfig })) ??
      {};
  }

  const assembled = assembleInitConfig(path.basename(projectDir), pluginBlocks);
  const parsed = sandboxConfigSchema.parse(assembled);

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  logger.success(`Wrote ${configPath}`);
  logger.info(
    `Edit it to add allowed proxy domains and tune plugin settings. User-level defaults (credential providers, per-plugin defaults) live at ${userConfigPath()}.`,
  );
}
