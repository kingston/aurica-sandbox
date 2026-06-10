// The platform guard (`assertPlatformSupported`) rejects non-macOS hosts so
// users get a clear error before any `orbctl` call. Tests mock the provider and
// run on Linux CI, so bypass the guard for the whole suite.
process.env.AURICA_SKIP_PLATFORM_CHECK = '1';
