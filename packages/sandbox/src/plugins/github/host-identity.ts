import { execa } from 'execa';

import type { GithubUserIdentity } from './schema.js';

/**
 * Read the host machine's git identity from `~/.gitconfig`. Used at
 * `aurica-sandbox init` time to pre-fill the github plugin's `user` field
 * in the sample sandbox config — once committed, the values are
 * authoritative and reproducible across machines.
 *
 * Uses `git config --global --get` (rather than parsing the file ourselves)
 * so includes, conditional includes, and the user's configured precedence
 * rules all apply naturally.
 *
 * Returns `null` if either `user.name` or `user.email` is missing or if
 * git itself isn't available — partial identity is worse than none, so
 * the caller should treat the field as unset and let the user fill it in.
 */
export async function readHostGitIdentity(): Promise<GithubUserIdentity | null> {
  try {
    const [{ stdout: name }, { stdout: email }] = await Promise.all([
      execa('git', ['config', '--global', '--get', 'user.name']),
      execa('git', ['config', '--global', '--get', 'user.email']),
    ]);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail) return null;
    return { name: trimmedName, email: trimmedEmail };
  } catch {
    // git not installed, no global config, or key unset — caller treats null
    // as "ask the user to fill it in", which is the correct UX for init.
    return null;
  }
}

/**
 * Parse the `<owner>/<repo>` slug out of a GitHub remote URL. Handles the
 * SSH (`git@github.com:owner/repo.git`), HTTPS
 * (`https://github.com/owner/repo.git`), and `ssh://` forms, stripping any
 * trailing `.git`. Returns `null` for non-GitHub or unparseable URLs.
 */
export function parseGithubRepoSlug(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/**
 * Detect the GitHub `<owner>/<repo>` for the repository at `cwd` by reading
 * its `origin` remote (falling back to any configured remote). Used at
 * `aurica-sandbox init` to pre-fill the repository to clone. Returns `null`
 * when `cwd` isn't a git repo, has no GitHub remote, or git is unavailable.
 */
export async function detectGithubRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], {
      cwd,
    });
    return parseGithubRepoSlug(stdout);
  } catch {
    return null;
  }
}
