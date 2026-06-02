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

/**
 * Resolve the sandbox a command should operate on.
 *
 * When `nameArg` is given, looks it up directly by name. When omitted,
 * falls back to the project's primary via {@link findPrimary} — mirroring
 * how `create` defaults to the project's configured sandbox so commands
 * can be run without repeating the name.
 *
 * Throws a command-friendly error if the named sandbox is unknown or no
 * primary exists for the project.
 */
export function resolveTarget(
  state: State,
  projectDir: string,
  nameArg?: string,
): SandboxEntry {
  if (nameArg) {
    const entry = state.sandboxes[nameArg];
    if (!entry) {
      throw new Error(
        `Sandbox ${nameArg} not found. Run \`aurica-sandbox list\` to see registered sandboxes.`,
      );
    }
    return entry;
  }

  const primary = findPrimary(state, projectDir);
  if (!primary) {
    throw new Error(
      `No primary sandbox found for ${projectDir}. Run \`aurica-sandbox create\` first, or pass an explicit name.`,
    );
  }
  return primary;
}
