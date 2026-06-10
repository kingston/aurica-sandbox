import process from 'node:process';

/**
 * The platform sandbox VMs require. OrbStack — the only supported provider —
 * runs on macOS only.
 */
const SUPPORTED_PLATFORM: NodeJS.Platform = 'darwin';

/**
 * Throw a clear error when the host platform can't run sandbox VMs.
 *
 * Called at the top of every VM-touching command so non-macOS users get an
 * actionable message instead of an opaque `orbctl`-not-found failure deep in
 * the provider. Host-only commands (`doctor`, `proxy`, `init`, `list`) do not
 * call this — `doctor` reports the platform as one of its checks instead.
 */
export function assertPlatformSupported(): void {
  if (process.platform !== SUPPORTED_PLATFORM) {
    throw new Error(
      `@aurica/sandbox requires macOS with OrbStack; OrbStack is macOS-only. Detected platform: ${process.platform}.`,
    );
  }
}

/** Whether the host platform can run sandbox VMs (macOS). */
export function isPlatformSupported(): boolean {
  return process.platform === SUPPORTED_PLATFORM;
}
