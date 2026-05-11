import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readHostCursor } from './host-cursor.js';

const VALID_COMMIT = '3e548838cf824b70851dd3ef27d0c6aae371b3f6';

function writeFixture(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-product-'));
  const file = path.join(dir, 'product.json');
  fs.writeFileSync(file, contents);
  return file;
}

const fixtures: string[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const file = fixtures.pop();
    if (file) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }
});

function fixture(contents: string): string {
  const file = writeFixture(contents);
  fixtures.push(file);
  return file;
}

describe('readHostCursor', () => {
  it('returns commit + arch when product.json is well-formed', () => {
    const file = fixture(
      JSON.stringify({ commit: VALID_COMMIT, name: 'Cursor' }),
    );
    expect(readHostCursor({ candidates: [file], hostArch: 'arm64' })).toEqual({
      commit: VALID_COMMIT,
      arch: 'arm64',
    });
  });

  it('maps node "x64" to the cursor "x64" tarball segment', () => {
    const file = fixture(JSON.stringify({ commit: VALID_COMMIT }));
    expect(readHostCursor({ candidates: [file], hostArch: 'x64' })).toEqual({
      commit: VALID_COMMIT,
      arch: 'x64',
    });
  });

  it('falls back to the second candidate when the first is missing', () => {
    const missing = path.join(
      os.tmpdir(),
      'definitely-does-not-exist-product.json',
    );
    const file = fixture(JSON.stringify({ commit: VALID_COMMIT }));
    expect(
      readHostCursor({ candidates: [missing, file], hostArch: 'arm64' }),
    ).toEqual({ commit: VALID_COMMIT, arch: 'arm64' });
  });

  it('returns null when no candidate exists', () => {
    const missing = path.join(
      os.tmpdir(),
      'definitely-does-not-exist-product.json',
    );
    expect(
      readHostCursor({ candidates: [missing], hostArch: 'arm64' }),
    ).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const file = fixture('{ not json');
    expect(
      readHostCursor({ candidates: [file], hostArch: 'arm64' }),
    ).toBeNull();
  });

  it('returns null when commit field is missing', () => {
    const file = fixture(JSON.stringify({ name: 'Cursor' }));
    expect(
      readHostCursor({ candidates: [file], hostArch: 'arm64' }),
    ).toBeNull();
  });

  it('returns null on non-hex / wrong-length commit', () => {
    const tooShort = fixture(JSON.stringify({ commit: 'abc123' }));
    expect(
      readHostCursor({ candidates: [tooShort], hostArch: 'arm64' }),
    ).toBeNull();

    const nonHex = fixture(JSON.stringify({ commit: 'z'.repeat(40) }));
    expect(
      readHostCursor({ candidates: [nonHex], hostArch: 'arm64' }),
    ).toBeNull();
  });

  it('returns null on unsupported host arch', () => {
    const file = fixture(JSON.stringify({ commit: VALID_COMMIT }));
    expect(readHostCursor({ candidates: [file], hostArch: 'ia32' })).toBeNull();
  });

  it('prefers realCommit over commit when both are present', () => {
    // Cursor's product.json carries `commit` with its last char replaced
    // by `commitLastCharacter` (a channel marker), and `realCommit` with
    // the actual upstream commit the REH tarball is published under.
    // Picking the wrong field 403s against downloads.cursor.com.
    const realCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6';
    const altered = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0';
    const file = fixture(
      JSON.stringify({
        commit: altered,
        realCommit,
        commitLastCharacter: '0',
      }),
    );
    expect(readHostCursor({ candidates: [file], hostArch: 'arm64' })).toEqual({
      commit: realCommit,
      arch: 'arm64',
    });
  });

  it('falls back to commit when realCommit is absent (older builds)', () => {
    const file = fixture(JSON.stringify({ commit: VALID_COMMIT }));
    expect(readHostCursor({ candidates: [file], hostArch: 'arm64' })).toEqual({
      commit: VALID_COMMIT,
      arch: 'arm64',
    });
  });

  it('falls back to commit when realCommit is malformed', () => {
    const file = fixture(
      JSON.stringify({ commit: VALID_COMMIT, realCommit: 'not-a-hash' }),
    );
    expect(readHostCursor({ candidates: [file], hostArch: 'arm64' })).toEqual({
      commit: VALID_COMMIT,
      arch: 'arm64',
    });
  });
});
