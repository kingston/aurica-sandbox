import type { UserPlugin } from './user.js';

/** A plugin shape with the discriminator required and other fields opaque. */
export interface PluginLike {
  type: UserPlugin['type'];
  [key: string]: unknown;
}

/**
 * Merge user-level plugin defaults onto project-level plugin entries.
 *
 * Iteration is over **project** plugins, not user plugins, so the project
 * must opt in to a plugin type before the user-level defaults of that type
 * apply. A user-level github plugin does NOT silently leak into a project
 * that hasn't declared `{ type: 'github' }`.
 *
 * Field-level merge with project precedence — `{ ...userMatch,
 * ...projectPlugin }`. Values defined on the project win; values defined
 * only on the user layer are inherited. Arrays (`repositories`) are
 * atomic: if the project sets them, the user-level array is dropped
 * entirely (no element-wise merge).
 *
 * If multiple user-level plugins share the same `type`, only the first is
 * used. This is a known limitation; revisit with schema-level dedupe if it
 * becomes a real problem.
 *
 * The result is loosely typed because the merged shape is re-validated
 * against the strict plugin schema by the caller.
 */
export function mergePlugins(
  userPlugins: readonly UserPlugin[],
  projectPlugins: readonly PluginLike[],
): PluginLike[] {
  return projectPlugins.map((projectPlugin) => {
    const userMatch = userPlugins.find((u) => u.type === projectPlugin.type);
    if (!userMatch) return projectPlugin;
    return { ...userMatch, ...projectPlugin };
  });
}
