export {
  expandPlugins,
  githubDomainsForGitCoverage,
  type ExpandContext,
  type ExpandedPlugins,
} from './expand.js';
export { PLUGINS } from './registry.js';
export {
  projectPluginsSchema,
  userPluginsSchema,
  type ClaudeCodeProjectConfig,
  type CursorProjectConfig,
  type DockerProjectConfig,
  type GithubProjectConfig,
  type GithubUserConfig,
  type MiseProjectConfig,
  type ProjectPlugins,
  type UserPlugins,
} from './schema.js';
export type {
  InitializedPlugin,
  PluginCommand,
  PluginInitContext,
  SandboxPlugin,
} from './types.js';
