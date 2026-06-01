import { describe, expect, it } from 'vitest';

import {
  type BufferedDecision,
  formatRequestBlock,
  type InflightRequest,
} from './process.js';

/** Build an in-flight entry with a `decision` payload for block rendering. */
function entry(
  decision: BufferedDecision,
  sourceName?: string,
): InflightRequest {
  return {
    remoteIp: '192.168.139.76',
    ...(sourceName ? { sourceName } : {}),
    decision,
  };
}

describe('formatRequestBlock', () => {
  it('puts emoji/status on the parent line and hangs policy + mutations below', () => {
    const block = formatRequestBlock(
      entry(
        {
          type: 'decision',
          id: '1',
          method: 'GET',
          host: 'api.anthropic.com',
          path: '/api/oauth/profile',
          remoteIp: '192.168.139.76',
          outcome: 'pass',
          matchedPolicyId: 'claude-code:api',
          appliedMutations: [
            {
              kind: 'replace-header',
              target: 'Authorization',
              status: 'applied',
            },
            {
              kind: 'remove-header',
              target: 'x-api-key',
              status: 'skipped',
              reason: 'not present',
            },
          ],
        },
        'mcp-sandbox-1',
      ),
      { statusCode: 401, statusMessage: 'Unauthorized' },
    );
    const lines = block.split('\n');

    // Parent: [source]<pad-to-18> 🔴 401 GET host/path — no status message,
    // no scheme. [mcp-sandbox-1] is 15 chars, padEnd(18) adds 3, then one space
    // before the emoji = 4 spaces.
    expect(lines[0]).toBe(
      '[mcp-sandbox-1]    🔴 401 GET https://api.anthropic.com/api/oauth/profile',
    );
    expect(block).not.toContain('Unauthorized');

    // Children carry tree connectors aligned under the source bracket: `│ ` for
    // every line but the last, `└─` for the last; mutation rows nest one deeper.
    expect(block).toContain('│  policy: claude-code:api');
    expect(block).toContain('│  mutations:');
    expect(block).toContain('│   ✓︎ replace-header  Authorization = <redacted>');
    expect(lines.at(-1)).toBe(
      '           └─  ⚠︎ remove-header   x-api-key (skipped: not present)',
    );
  });

  it('folds the query into the parent URL and prints no mutation rows when none configured', () => {
    const block = formatRequestBlock(
      entry({
        type: 'decision',
        id: '2',
        method: 'GET',
        host: 'api.anthropic.com',
        path: '/mcp-registry/v0/servers?version=latest&limit=100',
        remoteIp: '192.168.139.76',
        outcome: 'pass',
        matchedPolicyId: 'claude-code:api',
        appliedMutations: [],
      }),
      { statusCode: 200, statusMessage: 'OK' },
    );
    const lines = block.split('\n');

    expect(lines[0]).toContain(
      '🟢 200 GET https://api.anthropic.com/mcp-registry/v0/servers?version=latest&limit=100',
    );
    // policy is the only child, so it terminates the tree.
    expect(lines.at(-1)).toContain('└─ policy: claude-code:api');
    expect(block).not.toContain('mutations:');
    expect(block).not.toContain('query:');
  });

  it('prints only the parent line for a pass that matched no policy and applied no mutations', () => {
    const block = formatRequestBlock(
      {
        remoteIp: '10.0.0.5',
        sourceName: 'sandbox-1',
        decision: {
          type: 'decision',
          id: '3',
          method: 'GET',
          host: 'example.com',
          path: '/',
          remoteIp: '10.0.0.5',
          outcome: 'pass',
          appliedMutations: [],
        },
      },
      { statusCode: 200, statusMessage: 'OK' },
    );
    // No matched policy + no mutations → bare parent line, no children, no
    // forced `└─`. This is the common allowlisted pass-through (git/npm/github).
    expect(block.split('\n')).toHaveLength(1);
    expect(block).not.toContain('policy:');
    expect(block).not.toContain('└─');
    expect(block).toContain('🟢 200 GET https://example.com/');
  });

  it('renders a decision-less entry (non-verbose path) from method/url metadata', () => {
    const block = formatRequestBlock(
      {
        remoteIp: '192.168.139.76',
        sourceName: 'aurica-sandbox',
        method: 'GET',
        url: 'https://api.anthropic.com/v1/mcp_servers?limit=1000',
      },
      { statusCode: 200, statusMessage: 'OK' },
    );
    // One line, full URL, no children — the same shape as a verbose
    // bare-parent pass, so verbose and non-verbose output don't diverge.
    expect(block.split('\n')).toHaveLength(1);
    expect(block).toBe(
      '[aurica-sandbox]   🟢 200 GET https://api.anthropic.com/v1/mcp_servers?limit=1000',
    );
  });

  it('falls back to the raw IP when no sandbox name is known', () => {
    const block = formatRequestBlock(
      entry({
        type: 'denial',
        id: '4',
        method: 'POST',
        host: 'example.invalid',
        path: '/api',
        remoteIp: '10.0.0.5',
        reason: 'allowlist',
      }),
      { statusCode: 403, statusMessage: 'Forbidden' },
    );
    // No sourceName → falls back to the decision's raw IP in the bracket.
    expect(block.split('\n')[0]).toContain('[10.0.0.5]');
    expect(block).toContain('└─ denied: allowlist');
  });

  it('renders an aborted outcome with the ⚫ marker on the parent line', () => {
    const block = formatRequestBlock(
      entry(
        {
          type: 'decision',
          id: '5',
          method: 'POST',
          host: 'api.anthropic.com',
          path: '/v1/messages?beta=true',
          remoteIp: '192.168.139.76',
          outcome: 'pass',
          appliedMutations: [],
        },
        'mcp-sandbox-1',
      ),
      'aborted',
    );
    expect(block.split('\n')[0]).toContain('⚫ aborted POST');
  });

  it('truncates a long source name to the fixed width', () => {
    const block = formatRequestBlock(
      entry(
        {
          type: 'decision',
          id: '6',
          method: 'GET',
          host: 'example.com',
          path: '/',
          remoteIp: '10.0.0.5',
          outcome: 'pass',
          appliedMutations: [],
        },
        'a-very-long-sandbox-name-indeed',
      ),
      { statusCode: 200, statusMessage: 'OK' },
    );
    const [parent] = block.split('\n');
    // [name…] padded to exactly 18 chars before the single space + emoji.
    expect(parent?.indexOf('🟢')).toBe(19);
    expect(parent).toContain('…]');
  });
});
