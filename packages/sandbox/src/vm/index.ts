import { orbProvider } from './providers/orb/index.js';
import type { SandboxVMProvider } from './types.js';

/**
 * The active sandbox VM provider. Currently always {@link orbProvider}; in
 * the future this is the seam where Lima or another backend would be wired
 * in based on `aurica-sandbox.json` or an env var.
 *
 * Command code (create, start, stop, destroy) consumes this typed handle so
 * it stays free of provider-specific imports.
 */
export const defaultProvider: SandboxVMProvider = orbProvider;

export type {
  CreateVMOptions,
  HostBridgeIp,
  SandboxVM,
  SandboxVMProvider,
  VMExec,
} from './types.js';
