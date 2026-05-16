import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readUpstreamSlot } from './credentials-store.js';
import { FileOAuthProvider } from './file-oauth-provider.js';

const clientMetadata: OAuthClientMetadata = {
  client_name: 'aurica-sandbox-test',
  redirect_uris: ['http://127.0.0.1:54321/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

describe('FileOAuthProvider', () => {
  let dir: string;
  let file: string;
  let captured: URL[];
  let provider: FileOAuthProvider;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurica-oauth-'));
    file = path.join(dir, 'credentials.json');
    captured = [];
    provider = new FileOAuthProvider({
      upstream: 'github',
      redirectUrl: 'http://127.0.0.1:54321/callback',
      clientMetadata,
      credentialsPath: file,
      onAuthorizationUrl: (url) => {
        captured.push(url);
      },
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for clientInformation when nothing is cached (triggers DCR)', async () => {
    const info = await provider.clientInformation();
    expect(info).toBeUndefined();
  });

  it('persists clientInformation through saveClientInformation', async () => {
    await provider.saveClientInformation({
      client_id: 'abc',
      redirect_uris: ['http://127.0.0.1:54321/callback'],
    });
    const slot = await readUpstreamSlot('github', file);
    expect(slot?.clientInformation).toMatchObject({ client_id: 'abc' });
  });

  it('persists tokens through saveTokens and reads them back', async () => {
    await provider.saveTokens({
      access_token: 'a',
      token_type: 'bearer',
      refresh_token: 'r',
    });
    const tokens = await provider.tokens();
    expect(tokens).toMatchObject({ access_token: 'a', refresh_token: 'r' });
  });

  it('forwards authorizationUrl to the onAuthorizationUrl hook', async () => {
    const url = new URL('https://example.com/authorize?x=1');
    await provider.redirectToAuthorization(url);
    expect(captured).toEqual([url]);
  });

  it('codeVerifier round-trips after saveCodeVerifier', () => {
    provider.saveCodeVerifier('verifier-abc');
    expect(provider.codeVerifier()).toBe('verifier-abc');
  });

  it('codeVerifier throws when called before saveCodeVerifier', () => {
    expect(() => provider.codeVerifier()).toThrow(/code verifier not set/);
  });

  it('invalidateCredentials("all") deletes the entire upstream slot', async () => {
    await provider.saveClientInformation({
      client_id: 'abc',
      redirect_uris: ['http://127.0.0.1:54321/callback'],
    });
    await provider.invalidateCredentials('all');
    const slot = await readUpstreamSlot('github', file);
    expect(slot).toBeUndefined();
  });

  it('invalidateCredentials("tokens") clears only tokens, preserves client info', async () => {
    await provider.saveClientInformation({
      client_id: 'abc',
      redirect_uris: ['http://127.0.0.1:54321/callback'],
    });
    await provider.saveTokens({
      access_token: 'a',
      token_type: 'bearer',
    });
    await provider.invalidateCredentials('tokens');
    const slot = await readUpstreamSlot('github', file);
    expect(slot?.clientInformation).toBeDefined();
    expect(slot?.tokens).toBeUndefined();
  });

  it('scopes per-upstream: writes to "github" do not affect "linear"', async () => {
    const linear = new FileOAuthProvider({
      upstream: 'linear',
      redirectUrl: 'http://127.0.0.1:54322/callback',
      clientMetadata,
      credentialsPath: file,
      onAuthorizationUrl: () => undefined,
    });
    await provider.saveTokens({
      access_token: 'a-github',
      token_type: 'bearer',
    });
    await linear.saveTokens({ access_token: 'a-linear', token_type: 'bearer' });
    const githubTokens = await provider.tokens();
    const linearTokens = await linear.tokens();
    expect(githubTokens?.access_token).toBe('a-github');
    expect(linearTokens?.access_token).toBe('a-linear');
  });
});
