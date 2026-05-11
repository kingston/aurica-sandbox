import { claudeCodePlugin } from './claude-code/index.js';
import { cursorPlugin } from './cursor/index.js';
import { dockerPlugin } from './docker/index.js';
import { githubPlugin } from './github/index.js';
import { misePlugin } from './mise/index.js';
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
] as const satisfies readonly SandboxPlugin[];

/** Tuple type of the registry, used to derive keyed config schemas. */
export type PluginRegistry = typeof PLUGINS;
