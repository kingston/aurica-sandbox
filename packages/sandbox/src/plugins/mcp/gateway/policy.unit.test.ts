import { describe, expect, it } from 'vitest';

import type { CanonicalToolPolicy } from '../schema.js';
import { filterToolsForList, matchToolCall } from './policy.js';

const tools = [{ name: 'echo' }, { name: 'count' }, { name: 'noisy' }];

describe('filterToolsForList', () => {
  it('returns the input untouched when defaultAction is allow', () => {
    const out = filterToolsForList(tools, [], 'allow');
    expect(out).toBe(tools);
  });

  it('keeps only policy-mentioned tools under defaultAction block', () => {
    const policies: CanonicalToolPolicy[] = [
      { tools: ['echo'], arguments: undefined },
    ];
    expect(filterToolsForList(tools, policies, 'block')).toEqual([
      { name: 'echo' },
    ]);
  });

  it('unions tool names across policies and ignores argument constraints', () => {
    const policies: CanonicalToolPolicy[] = [
      { tools: ['echo'], arguments: { text: 'only-this' } },
      { tools: ['count', 'echo'], arguments: undefined },
    ];
    expect(
      filterToolsForList(tools, policies, 'block')
        .map((t) => t.name)
        .sort(),
    ).toEqual(['count', 'echo']);
  });
});

describe('matchToolCall', () => {
  it('allows everything under defaultAction allow with no policies', () => {
    const decision = matchToolCall([], 'allow', { name: 'echo' });
    expect(decision).toEqual({ allow: true });
  });

  it('blocks unknown tool names under defaultAction block', () => {
    const policies: CanonicalToolPolicy[] = [
      { tools: ['echo'], arguments: undefined },
    ];
    const decision = matchToolCall(policies, 'block', { name: 'count' });
    expect(decision).toEqual({
      allow: false,
      reason: 'tool count is not allowed for this sandbox',
    });
  });

  it('allows when args satisfy a policy via subset equality', () => {
    const policies: CanonicalToolPolicy[] = [
      { tools: ['echo'], arguments: { text: 'hello' } },
    ];
    const decision = matchToolCall(policies, 'block', {
      name: 'echo',
      arguments: { text: 'hello', flair: '!' },
    });
    expect(decision).toEqual({ allow: true });
  });

  it('reports both a missing key and a mismatched value in one denial', () => {
    const policies: CanonicalToolPolicy[] = [
      { tools: ['echo'], arguments: { text: 'hello', flair: '!' } },
    ];
    const decision = matchToolCall(policies, 'block', {
      name: 'echo',
      arguments: { text: 'world' },
    });
    expect(decision).toEqual({
      allow: false,
      reason:
        'tool echo call denied: argument "text" must equal "hello" (got "world"); ' +
        'argument "flair" is required (expected "!", but it was missing from the call)',
    });
  });

  it('first-match-wins: a broader later policy can rescue a narrow earlier failure', () => {
    const policies: CanonicalToolPolicy[] = [
      { tools: ['echo'], arguments: { text: 'only-this' } },
      { tools: ['echo'], arguments: undefined },
    ];
    const decision = matchToolCall(policies, 'block', {
      name: 'echo',
      arguments: { text: 'anything' },
    });
    expect(decision).toEqual({ allow: true });
  });

  it('falls through to allow when defaultAction is allow even after an arg mismatch', () => {
    const policies: CanonicalToolPolicy[] = [
      { tools: ['echo'], arguments: { text: 'hello' } },
    ];
    const decision = matchToolCall(policies, 'allow', {
      name: 'echo',
      arguments: { text: 'something-else' },
    });
    expect(decision).toEqual({ allow: true });
  });
});
