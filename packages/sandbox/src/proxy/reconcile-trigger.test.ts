import { describe, expect, it, vi } from 'vitest';

import { createReconcileTrigger } from './process.js';

/** A promise whose resolution is driven manually by the test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createReconcileTrigger', () => {
  it('shares one runReconcile across a burst of concurrent IPs', async () => {
    const gate = deferred();
    const runReconcile = vi.fn<() => Promise<void>>(() => gate.promise);
    // Both IPs register by the time the sweep settles.
    const isRegistered = (): boolean => true;
    const trigger = createReconcileTrigger({ runReconcile, isRegistered });

    const a = trigger('10.0.0.1');
    const b = trigger('10.0.0.2');
    // The sweep is in flight; both callers await the same promise.
    expect(runReconcile).toHaveBeenCalledTimes(1);

    gate.resolve();
    await Promise.all([a, b]);
    expect(runReconcile).toHaveBeenCalledTimes(1);
  });

  it('re-triggers a fresh sweep after the prior one settles', async () => {
    const runReconcile = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const trigger = createReconcileTrigger({
      runReconcile,
      isRegistered: () => true,
    });

    await trigger('10.0.0.1');
    await trigger('10.0.0.2');
    expect(runReconcile).toHaveBeenCalledTimes(2);
  });

  it('arms a cooldown for an IP still unregistered after the sweep', async () => {
    let clock = 1000;
    const runReconcile = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const trigger = createReconcileTrigger({
      runReconcile,
      isRegistered: () => false, // sweep never resolves this IP
      now: () => clock,
      cooldownMs: 5000,
    });

    await trigger('10.0.0.9');
    expect(runReconcile).toHaveBeenCalledTimes(1);

    // Within the cooldown window: skips the sweep entirely.
    clock = 4000;
    await trigger('10.0.0.9');
    expect(runReconcile).toHaveBeenCalledTimes(1);

    // Past the cooldown window: sweeps again.
    clock = 6001;
    await trigger('10.0.0.9');
    expect(runReconcile).toHaveBeenCalledTimes(2);
  });

  it('does not cooldown an IP that registered during the sweep', async () => {
    let clock = 0;
    const registered = new Set<string>();
    const runReconcile = vi.fn<() => Promise<void>>(() => {
      registered.add('10.0.0.5'); // sweep discovers + registers the VM
      return Promise.resolve();
    });
    const trigger = createReconcileTrigger({
      runReconcile,
      isRegistered: (ip) => registered.has(ip),
      now: () => clock,
      cooldownMs: 5000,
    });

    await trigger('10.0.0.5');
    // No cooldown armed, so an immediate re-trigger still sweeps (caller would
    // normally short-circuit a registered IP before reaching here).
    clock = 1;
    await trigger('10.0.0.5');
    expect(runReconcile).toHaveBeenCalledTimes(2);
  });

  it('clears the cooldown map when it exceeds the cap', async () => {
    let clock = 0;
    const runReconcile = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const trigger = createReconcileTrigger({
      runReconcile,
      isRegistered: () => false,
      now: () => clock,
      cooldownMs: 100_000,
      cooldownMax: 2,
    });

    await trigger('a');
    await trigger('b');
    // Map is at the cap (2). The next unresolved IP clears it, then records 'c'.
    await trigger('c');

    // 'a' was evicted by the clear, so it sweeps immediately rather than being
    // suppressed; 'c' is still within its cooldown and is skipped.
    clock = 1;
    const before = runReconcile.mock.calls.length;
    await trigger('c');
    expect(runReconcile.mock.calls.length).toBe(before); // 'c' suppressed
    await trigger('a');
    expect(runReconcile.mock.calls.length).toBe(before + 1); // 'a' swept
  });
});
