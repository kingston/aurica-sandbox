import type { GitConfig, ProxyAction } from '#src/config/index.js';
import type { GithubPlugin } from '#src/plugins/index.js';
import { GIT_TOKEN_PLACEHOLDER } from '#src/vm/init/run-init.js';

/**
 * Parse a github URL like `https://github.com/foo/bar` or
 * `https://github.com/foo/bar.git` into `{ owner, repo }`. Returns null for
 * any URL whose host isn't `github.com` or whose path doesn't have at least
 * two segments.
 */
function parseGithubRepoFromUrl(
  url: string,
): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return null;
  const segments = parsed.pathname.replace(/^\//, '').split('/');
  if (segments.length < 2) return null;
  const [owner, repoRaw] = segments;
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/, '');
  if (!repo) return null;
  return { owner, repo };
}

/**
 * Synthesize a github plugin from `config.git` when both URL and token
 * are set and the URL points at github.com. Returns null otherwise so the
 * caller falls back to host-only auth.
 */
export function githubPluginFromGitConfig(
  git: GitConfig | undefined,
): GithubPlugin | null {
  if (!git?.tokenSource) return null;
  const repo = parseGithubRepoFromUrl(git.url);
  if (!repo) return null;
  return {
    type: 'github',
    repositories: [{ name: `${repo.owner}/${repo.repo}` }],
    token: git.tokenSource,
  };
}

/**
 * Fallback host-level proxy action for non-github git URLs (gitlab,
 * bitbucket, self-hosted). Preserves pre-integrations behavior for hosts
 * with no provider yet.
 */
export function nonGithubGitAction(
  git: GitConfig | undefined,
): ProxyAction | null {
  if (!git?.tokenSource) return null;
  if (parseGithubRepoFromUrl(git.url)) return null;
  return {
    domain: new URL(git.url).host,
    hook: 'replaceApiKey',
    header: 'Authorization',
    placeholderValue: GIT_TOKEN_PLACEHOLDER,
    replacementValue: git.tokenSource,
  };
}

/** Whether `config.git` will produce a host-level fallback action. */
export function gitNeedsHostLevelPlaceholder(
  git: GitConfig | undefined,
): boolean {
  return nonGithubGitAction(git) !== null;
}
