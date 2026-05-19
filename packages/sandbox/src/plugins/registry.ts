import { claudeCodePlugin } from './claude-code/claude-code.plugin.js';
import { cursorPlugin } from './cursor/cursor.plugin.js';
import { dockerPlugin } from './docker/docker.plugin.js';
import { githubPlugin } from './github/github.plugin.js';
import { mcpPlugin } from './mcp/mcp.plugin.js';
import { misePlugin } from './mise/mise.plugin.js';
import type { SandboxPlugin } from './types.js';

/**
 * Every plugin the sandbox knows about. The framework derives:
 *
 * 1. The strict keyed project-config schema (`{ github: ..., docker: ..., ... }`)
 *    in `plugins/schema.ts`.
 * 2. The strict keyed user-config schema (same shape, only plugins whose
 *    `userConfigSchema` is defined).
 * 3. The expansion order used by `expandPlugins` so bootstrap snippets and
 *    command lists concatenate deterministically regardless of config-file
 *    key order.
 *
 * Adding a plugin: implement the `SandboxPlugin` contract and add it to
 * this array. Everything else (config schema, expansion, listing) follows.
 *
 * `as const` plus the satisfies clause gives precise per-element TS types
 * so callers can do `PLUGINS[0].projectConfigSchema` and get the github
 * project schema's literal type, not the union.
 */
export const PLUGINS = [
  githubPlugin,
  dockerPlugin,
  misePlugin,
  claudeCodePlugin,
  cursorPlugin,
  mcpPlugin,
] as const satisfies readonly SandboxPlugin[];

/** Tuple type of the registry, used to derive keyed config schemas. */
export type PluginRegistry = typeof PLUGINS;
