import { describe, expect, it } from 'vitest';

import { orbctlErrorToCheck, summaryExitCode, type Check } from './doctor.js';

function check(status: Check['status']): Check {
  return { name: 't', status };
}

describe('summaryExitCode', () => {
  it('returns 0 when all checks pass', () => {
    expect(summaryExitCode([check('pass'), check('pass')])).toBe(0);
  });

  it('returns 0 when checks only warn', () => {
    expect(summaryExitCode([check('pass'), check('warn')])).toBe(0);
  });

  it('returns 1 when any check fails', () => {
    expect(summaryExitCode([check('pass'), check('warn'), check('fail')])).toBe(
      1,
    );
  });

  it('returns 0 for an empty set', () => {
    expect(summaryExitCode([])).toBe(0);
  });
});

describe('orbctlErrorToCheck', () => {
  it('classifies ENOENT as not installed', () => {
    const result = orbctlErrorToCheck(
      Object.assign(new Error('spawn orbctl ENOENT'), { code: 'ENOENT' }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('not installed');
    expect(result.hint).toContain('orbstack.dev');
  });

  it('classifies any other error as not running', () => {
    const result = orbctlErrorToCheck(new Error('connection refused'));
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('not running');
    expect(result.hint).toContain('orb start');
  });
});
