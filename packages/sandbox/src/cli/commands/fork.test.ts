import { describe, expect, it } from 'vitest';

import type { SandboxEntry, State } from '#src/state/index.js';

import { nextConcurrencyIndex } from './fork.js';

function fork(name: string, parentName: string, idx: number): SandboxEntry {
  return {
    name,
    projectDir: '/tmp/proj',
    status: 'running',
    ip: '192.168.1.10',
    createdAt: '2026-01-01T00:00:00.000Z',
    authSecret: 'test-secret',
    kind: 'fork',
    parentName,
    concurrencyIndex: idx,
  };
}

function stateWith(entries: SandboxEntry[]): State {
  return {
    version: 1,
    proxy: null,
    sandboxes: Object.fromEntries(entries.map((e) => [e.name, e])),
  };
}

describe('nextConcurrencyIndex', () => {
  it('returns 1 when the primary has no forks', () => {
    expect(nextConcurrencyIndex(stateWith([]), 'proj')).toBe(1);
  });

  it('returns the next index above a dense run', () => {
    const state = stateWith([
      fork('proj-fork-1', 'proj', 1),
      fork('proj-fork-2', 'proj', 2),
    ]);
    expect(nextConcurrencyIndex(state, 'proj')).toBe(3);
  });

  it('reuses a gap left by a destroyed fork', () => {
    const state = stateWith([
      fork('proj-fork-1', 'proj', 1),
      fork('proj-fork-3', 'proj', 3),
    ]);
    expect(nextConcurrencyIndex(state, 'proj')).toBe(2);
  });

  it('ignores forks belonging to a different primary', () => {
    const state = stateWith([
      fork('other-fork-1', 'other', 1),
      fork('other-fork-2', 'other', 2),
    ]);
    expect(nextConcurrencyIndex(state, 'proj')).toBe(1);
  });
});
