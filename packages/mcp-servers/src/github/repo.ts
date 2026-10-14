/**
 * Repository identity and the shapes GitHub answers in.
 *
 * Kept apart from the server so it can be tested without a token.
 */

/** A page bigger than this is never read in a chat reply. */
export const MAX_PER_PAGE = 50;
export const DEFAULT_PER_PAGE = 20;
export const DEFAULT_COMMITS = 10;

export interface RepoTarget {
  owner: string;
  repo: string;
}

/**
 * GitHub's own naming rules: owners are alphanumeric with single hyphens,
 * repositories also allow dot and underscore. Validated here because the values
 * come from a language model and go into a URL path.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidOwner(owner: string): boolean {
  return OWNER.test(owner);
}

export function isValidRepo(repo: string): boolean {
  return REPO.test(repo) && repo !== '.' && repo !== '..';
}

/**
 * Work out which repository a call means.
 *
 * `GITHUB_REPO=owner/name` sets a default, so the operator's own project does
 * not have to be named in every message — and so a model that guesses a
 * plausible-looking repository reaches ours rather than a stranger's.
 */
export function resolveTarget(
  args: { owner?: string; repo?: string },
  env: Record<string, string | undefined> = process.env,
): RepoTarget {
  const fallback = env.GITHUB_REPO?.trim();
  let owner = args.owner?.trim();
  let repo = args.repo?.trim();

  if ((!owner || !repo) && fallback) {
    const [defaultOwner, defaultRepo, ...rest] = fallback.split('/');
    if (!defaultOwner || !defaultRepo || rest.length > 0) {
      throw new Error(`GITHUB_REPO should look like "owner/name", got "${fallback}"`);
    }
    owner = owner || defaultOwner;
    repo = repo || defaultRepo;
  }

  if (!owner || !repo) {
    throw new Error(
      'No repository given. Pass owner and repo, or set GITHUB_REPO=owner/name.',
    );
  }
  if (!isValidOwner(owner)) throw new Error(`"${owner}" is not a valid GitHub owner name.`);
  if (!isValidRepo(repo)) throw new Error(`"${repo}" is not a valid repository name.`);

  return { owner, repo };
}

export function clampPerPage(requested: number | undefined, fallback = DEFAULT_PER_PAGE): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(requested)));
}

/**
 * A git ref that is safe to put in a URL path.
 *
 * Branch names allow a lot, but not these: refusing them here keeps a crafted
 * ref from reaching a different endpoint than the one intended.
 */
export function isValidRef(ref: string): boolean {
  if (ref === '' || ref.length > 255) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.startsWith('-')) return false;
  if (ref.includes('..') || ref.includes('//')) return false;
  return /^[A-Za-z0-9._\/-]+$/.test(ref);
}

/** A workflow is a file name or a numeric id. Anything else is a mistake. */
export function isValidWorkflowId(id: string): boolean {
  if (/^[0-9]+$/.test(id)) return true;
  return /^[A-Za-z0-9._-]+\.(?:yml|yaml)$/.test(id);
}

export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  running: number;
  skipped: number;
  verdict: 'passed' | 'failed' | 'running' | 'no checks';
}

/**
 * Reduce check runs to an answer.
 *
 * "Did CI pass?" wants one word. The guide's version called everything passed
 * when `check_runs` was empty, so a branch with no CI configured reported "all
 * checks passed" — which is the opposite of useful when someone is deciding
 * whether to deploy.
 */
export function summariseChecks(
  runs: ReadonlyArray<{ status?: string | null; conclusion?: string | null }>,
): CheckSummary {
  const summary: CheckSummary = {
    total: runs.length,
    passed: 0,
    failed: 0,
    running: 0,
    skipped: 0,
    verdict: 'no checks',
  };

  for (const run of runs) {
    if (run.status !== 'completed') {
      summary.running += 1;
      continue;
    }
    switch (run.conclusion) {
      case 'success':
        summary.passed += 1;
        break;
      case 'skipped':
      case 'neutral':
        summary.skipped += 1;
        break;
      case 'failure':
      case 'timed_out':
      case 'cancelled':
      case 'action_required':
      case 'stale':
        summary.failed += 1;
        break;
      default:
        summary.failed += 1;
    }
  }

  if (summary.total === 0) summary.verdict = 'no checks';
  else if (summary.failed > 0) summary.verdict = 'failed';
  else if (summary.running > 0) summary.verdict = 'running';
  else summary.verdict = 'passed';

  return summary;
}
