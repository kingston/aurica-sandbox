import type { SandboxEntry, State } from '#src/state/index.js';

/**
 * Find the primary sandbox entry for a given project directory.
 * Returns `undefined` if no primary exists yet.
 */
export function findPrimary(
  state: State,
  projectDir: string,
): SandboxEntry | undefined {
  return Object.values(state.sandboxes).find(
    (e) => e.kind === 'primary' && e.projectDir === projectDir,
  );
}
