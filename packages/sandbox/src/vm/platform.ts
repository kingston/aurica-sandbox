import process from 'node:process';

/**
 * The platform sandbox VMs require. OrbStack — the only supported provider —
 * runs on macOS only.
 */
const SUPPORTED_PLATFORM: NodeJS.Platform = 'darwin';

/**
 * Env var that, when set to `1`/`true`, disables {@link assertPlatformSupported}.
 * Lets command logic run on non-macOS hosts where the OrbStack provider is
 * mocked — chiefly the test suite (CI runs on Linux), where the platform check
 * would otherwise reject every VM-touching command before its mocks engage.
 */
const SKIP_PLATFORM_CHECK_ENV = 'AURICA_SKIP_PLATFORM_CHECK';

/** Whether `value` is an opt-in flag value (`1`/`true`, case-insensitive). */
function isEnvEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * Throw a clear error when the host platform can't run sandbox VMs.
 *
 * Called at the top of every VM-touching command so non-macOS users get an
 * actionable message instead of an opaque `orbctl`-not-found failure deep in
 * the provider. Host-only commands (`doctor`, `proxy`, `init`, `list`) do not
 * call this — `doctor` reports the platform as one of its checks instead.
 *
 * Set {@link SKIP_PLATFORM_CHECK_ENV} to bypass (used by tests on Linux CI).
 */
export function assertPlatformSupported(): void {
  if (isEnvEnabled(process.env[SKIP_PLATFORM_CHECK_ENV])) return;
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
