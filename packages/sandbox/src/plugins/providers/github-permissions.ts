import type { HttpMethod, MatcherEntry } from '#src/config/index.js';

/**
 * Hosts for which github capability endpoints are emitted. `*.githubusercontent.com`
 * and `cli.github.com` aren't in here because there's no per-repo notion of
 * authentication for them (raw content URLs are content-hashed; cli.github.com
 * is the apt repo).
 */
export type GithubAuthHost =
  | 'github.com'
  | 'api.github.com'
  | 'codeload.github.com';

/**
 * Names of the v1 capability set. The strings match the GitHub fine-grained
 * PAT taxonomy where reasonable, so users who have configured a PAT find
 * the same vocabulary here.
 */
export type GithubCapability =
  | 'contents'
  | 'pullRequests'
  | 'issues'
  | 'actions';

/**
 * One endpoint contributed by a capability/level: the host it lives on and
 * the matcher (path-shape + methods) the proxy should compare incoming
 * requests against. Path strings in `matcher` may contain `{owner}` and
 * `{repo}` placeholders that the expander interpolates per repo before
 * emitting the final ProxyPolicy.
 */
export interface GithubEndpoint {
  host: GithubAuthHost;
  matcher: MatcherEntry;
}

/**
 * Per-capability map of read / write endpoint sets. `write` always
 * includes the `read` set (safe methods stay reachable when the user
 * grants write).
 */
export type GithubCapabilityMap = Record<
  GithubCapability,
  { read: GithubEndpoint[]; write: GithubEndpoint[] }
>;

const writeMethods: HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

const contentsRead: GithubEndpoint[] = [
  // Smart-HTTP fetch handshake — both fetch and push start here, but
  // discrimination happens at the upload-pack vs receive-pack POST.
  {
    host: 'github.com',
    matcher: { exact: '/{owner}/{repo}/info/refs', methods: ['GET'] },
  },
  // Actual fetch payload.
  {
    host: 'github.com',
    matcher: {
      exact: '/{owner}/{repo}/git-upload-pack',
      methods: ['POST'],
    },
  },
  // Archive downloads — codeload responds to GETs only.
  {
    host: 'codeload.github.com',
    matcher: { prefix: '/{owner}/{repo}', methods: ['GET'] },
  },
  // REST repo metadata + read-only git data.
  {
    host: 'api.github.com',
    matcher: { exact: '/repos/{owner}/{repo}', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/contents', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/git', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/branches', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/commits', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/tags', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/tarball', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/zipball', methods: ['GET'] },
  },
];

const contentsWrite: GithubEndpoint[] = [
  ...contentsRead,
  // Smart-HTTP push payload — discriminator that distinguishes push from
  // fetch at the proxy level.
  {
    host: 'github.com',
    matcher: {
      exact: '/{owner}/{repo}/git-receive-pack',
      methods: ['POST'],
    },
  },
  // REST mutation surfaces under contents/git.
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/contents',
      methods: ['PUT', 'DELETE'],
    },
  },
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/git',
      methods: ['POST', 'PATCH'],
    },
  },
];

const pullRequestsRead: GithubEndpoint[] = [
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/pulls', methods: ['GET'] },
  },
];

const pullRequestsWrite: GithubEndpoint[] = [
  ...pullRequestsRead,
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/pulls',
      methods: writeMethods,
    },
  },
];

const issuesRead: GithubEndpoint[] = [
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/issues', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/labels', methods: ['GET'] },
  },
  {
    host: 'api.github.com',
    matcher: { prefix: '/repos/{owner}/{repo}/milestones', methods: ['GET'] },
  },
];

const issuesWrite: GithubEndpoint[] = [
  ...issuesRead,
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/issues',
      methods: writeMethods,
    },
  },
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/labels',
      methods: writeMethods,
    },
  },
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/milestones',
      methods: writeMethods,
    },
  },
];

const actionsRead: GithubEndpoint[] = [
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/actions/runs',
      methods: ['GET'],
    },
  },
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/actions/workflows',
      methods: ['GET'],
    },
  },
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/actions/jobs',
      methods: ['GET'],
    },
  },
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/actions/artifacts',
      methods: ['GET'],
    },
  },
];

const actionsWrite: GithubEndpoint[] = [
  ...actionsRead,
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/actions/runs',
      methods: ['POST'],
    },
  },
  {
    host: 'api.github.com',
    matcher: {
      prefix: '/repos/{owner}/{repo}/actions/workflows',
      methods: ['POST'],
    },
  },
];

/** Per-capability endpoint table. See {@link GithubCapability}. */
export const GITHUB_CAPABILITY_MAP: GithubCapabilityMap = {
  contents: { read: contentsRead, write: contentsWrite },
  pullRequests: { read: pullRequestsRead, write: pullRequestsWrite },
  issues: { read: issuesRead, write: issuesWrite },
  actions: { read: actionsRead, write: actionsWrite },
};

/**
 * Replace `{owner}` / `{repo}` placeholders in a matcher's path-shape
 * string. Returns a new matcher; original is untouched.
 */
export function interpolateMatcher(
  entry: MatcherEntry,
  owner: string,
  repo: string,
): MatcherEntry {
  const replace = (s: string): string =>
    s.replaceAll('{owner}', owner).replaceAll('{repo}', repo);
  if ('exact' in entry) {
    return { ...entry, exact: replace(entry.exact) };
  }
  if ('prefix' in entry) {
    return { ...entry, prefix: replace(entry.prefix) };
  }
  return { ...entry, regex: replace(entry.regex) };
}
