import { describe, expect, it } from 'vitest';

import {
  providerHealthToCheck,
  summaryExitCode,
  type Check,
} from './doctor.js';

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

describe('providerHealthToCheck', () => {
  it('maps an ok health to a passing check with the provider name', () => {
    const result = providerHealthToCheck('OrbStack', {
      status: 'ok',
      detail: 'installed, running',
    });
    expect(result.name).toBe('OrbStack');
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('installed, running');
  });

  it('maps not-installed to a failing check carrying the provider hint', () => {
    const result = providerHealthToCheck('OrbStack', {
      status: 'not-installed',
      hint: 'Install OrbStack from https://orbstack.dev.',
    });
    expect(result.name).toBe('OrbStack');
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('not installed');
    expect(result.hint).toContain('orbstack.dev');
  });

  it('maps not-running to a failing check', () => {
    const result = providerHealthToCheck('OrbStack', {
      status: 'not-running',
      hint: 'Start OrbStack (open the app or run `orb start`).',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('not running');
    expect(result.hint).toContain('orb start');
  });
});
