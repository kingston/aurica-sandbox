import { describe, expect, it } from 'vitest';

import {
  expandPlugins,
  type ProjectPlugins,
  type UserPlugins,
} from '../index.js';

const ctx = {
  linuxUser: 'sandbox',
  sandboxName: 'sb-test',
  authSecret: 'test-secret',
};
const emptyUser: UserPlugins = {};

describe('dockerPlugin', () => {
  it('contributes the apt repo and Docker Hub domains', async () => {
    const expanded = await expandPlugins({ docker: {} }, emptyUser, ctx);
    expect(expanded.domains).toEqual(
      expect.arrayContaining([
        'download.docker.com',
        'registry-1.docker.io',
        'auth.docker.io',
      ]),
    );
  });

  it('installs rootless Docker Engine and masks the rootful service', async () => {
    const expanded = await expandPlugins({ docker: {} }, emptyUser, ctx);
    expect(expanded.bootstrapScript).toMatch(/docker-ce-rootless-extras/);
    expect(expanded.bootstrapScript).toMatch(
      /dockerd-rootless-setuptool\.sh install/,
    );
    expect(expanded.bootstrapScript).toMatch(/loginctl enable-linger sandbox/);
    expect(expanded.bootstrapScript).toMatch(
      /systemctl mask docker\.service docker\.socket/,
    );
  });

  it('emits a post-lockdown command that writes DOCKER_HOST to /etc/environment', async () => {
    const expanded = await expandPlugins({ docker: {} }, emptyUser, ctx);
    expect(expanded.commands).toEqual([
      {
        user: 'root',
        argv: [
          'sh',
          '-c',
          String.raw`sed -i "/^DOCKER_HOST=/d" /etc/environment && printf "DOCKER_HOST=unix:///run/user/%s/docker.sock\n" "$(id -u "$1")" >> /etc/environment`,
          'sh',
          'sandbox',
        ],
      },
    ]);
  });

  it('emits no proxy policies', async () => {
    const expanded = await expandPlugins({ docker: {} }, emptyUser, ctx);
    expect(expanded.policies).toEqual([]);
  });
});

describe('dockerPlugin — ProjectPlugins type', () => {
  it('accepts docker: {} (no config required)', async () => {
    const project: ProjectPlugins = { docker: {} };
    const expanded = await expandPlugins(project, emptyUser, ctx);
    expect(expanded.enabledPlugins).toContain('docker');
  });
});
