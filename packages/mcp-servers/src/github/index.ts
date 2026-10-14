#!/usr/bin/env node
/**
 * GitHub MCP server.
 *
 * Five tools: three that read (open PRs, CI status, recent commits) and two
 * that act (trigger a workflow, open an issue).
 *
 * The two that act are marked `readOnlyHint: false` in their MCP annotations,
 * which is the hook the daemon's approval gate keys off — a model asking to
 * deploy should reach Approve/Deny buttons, not GitHub. Until that wiring lands
 * (days 13–14) they are gated by `GITHUB_ALLOW_WRITES`, because an MCP server
 * that can dispatch a production workflow is one prompt injection away from
 * doing it, and a Firestore document or an issue title is written by somebody
 * else.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { dataResult, errorResult } from '../shared/untrusted';
import {
  DEFAULT_COMMITS,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  clampPerPage,
  isValidRef,
  isValidWorkflowId,
  resolveTarget,
  summariseChecks,
} from './repo';

const SERVER_NAME = 'vigyl-github';
const VERSION = '0.2.0';

/** What a tool hands back. See the Firebase server for why this is not inferred. */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

type RegisterTool = (
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  },
  handler: (args: never) => Promise<ToolResult>,
) => void;

/**
 * The slice of Octokit used here.
 *
 * Declared rather than imported so the tests can pass a fake and the package
 * typechecks without the optional dependency installed.
 */
export interface GitHubApi {
  pulls: {
    list(params: Record<string, unknown>): Promise<{ data: PullRequest[] }>;
  };
  checks: {
    listForRef(params: Record<string, unknown>): Promise<{ data: { check_runs: CheckRun[] } }>;
  };
  repos: {
    listCommits(params: Record<string, unknown>): Promise<{ data: Commit[] }>;
  };
  actions: {
    createWorkflowDispatch(params: Record<string, unknown>): Promise<unknown>;
  };
  issues: {
    create(params: Record<string, unknown>): Promise<{ data: { number: number; html_url: string } }>;
  };
}

interface PullRequest {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface CheckRun {
  name: string;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
}

interface Commit {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string } | null };
  html_url: string;
}

/** Writes are off unless the operator turns them on. */
export function writesAllowed(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.GITHUB_ALLOW_WRITES?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

const WRITES_DISABLED =
  'Writing to GitHub is disabled. Set GITHUB_ALLOW_WRITES=true to enable it — ' +
  'and note that until the approval gate is wired to these tools, nothing will ' +
  'ask before it runs.';

export function registerGitHubTools(
  server: McpServer,
  api: GitHubApi,
  env: Record<string, string | undefined> = process.env,
): void {
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  const target = (args: { owner?: string; repo?: string }) => resolveTarget(args, env);

  const repoShape = {
    owner: z.string().optional().describe('Repository owner. Defaults to GITHUB_REPO.'),
    repo: z.string().optional().describe('Repository name. Defaults to GITHUB_REPO.'),
  };

  registerTool(
    'list_prs',
    {
      title: 'List pull requests',
      description: `Pull requests for a repository, most recently updated first. Up to ${MAX_PER_PAGE}.`,
      inputSchema: {
        ...repoShape,
        state: z.enum(['open', 'closed', 'all']).optional().describe('Default open.'),
        limit: z.number().int().optional().describe(`Default ${DEFAULT_PER_PAGE}, max ${MAX_PER_PAGE}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (raw: never): Promise<ToolResult> => {
      const args = raw as { owner?: string; repo?: string; state?: string; limit?: number };
      let where;
      try {
        where = target(args);
      } catch (error) {
        return errorResult((error as Error).message);
      }

      try {
        const { data } = await api.pulls.list({
          ...where,
          state: args.state ?? 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: clampPerPage(args.limit),
        });

        return dataResult(`github ${where.owner}/${where.repo} pull requests`, {
          repository: `${where.owner}/${where.repo}`,
          state: args.state ?? 'open',
          count: data.length,
          pullRequests: data.map((pr) => ({
            number: pr.number,
            title: pr.title,
            author: pr.user?.login ?? 'unknown',
            state: pr.state,
            draft: pr.draft === true,
            branch: pr.head?.ref,
            into: pr.base?.ref,
            updatedAt: pr.updated_at,
            url: pr.html_url,
          })),
        });
      } catch (error) {
        return errorResult(describeGitHubError(error, `${where.owner}/${where.repo}`));
      }
    },
  );

  registerTool(
    'ci_status',
    {
      title: 'CI status',
      description:
        'Whether checks passed for a branch, tag or commit. Says "no checks" ' +
        'when none ran, which is not the same as passing.',
      inputSchema: {
        ...repoShape,
        ref: z.string().optional().describe('Branch, tag or SHA. Default main.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (raw: never): Promise<ToolResult> => {
      const args = raw as { owner?: string; repo?: string; ref?: string };
      let where;
      try {
        where = target(args);
      } catch (error) {
        return errorResult((error as Error).message);
      }

      const ref = args.ref?.trim() || 'main';
      if (!isValidRef(ref)) return errorResult(`"${ref}" is not a valid git ref.`);

      try {
        const { data } = await api.checks.listForRef({ ...where, ref, per_page: MAX_PER_PAGE });
        const summary = summariseChecks(data.check_runs);

        return dataResult(`github ${where.owner}/${where.repo} checks for ${ref}`, {
          repository: `${where.owner}/${where.repo}`,
          ref,
          verdict: summary.verdict,
          counts: {
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            running: summary.running,
            skipped: summary.skipped,
          },
          checks: data.check_runs.map((run) => ({
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            completedAt: run.completed_at,
            url: run.html_url,
          })),
        });
      } catch (error) {
        return errorResult(describeGitHubError(error, `${where.owner}/${where.repo}@${ref}`));
      }
    },
  );

  registerTool(
    'recent_commits',
    {
      title: 'Recent commits',
      description: 'The latest commits on a branch, newest first.',
      inputSchema: {
        ...repoShape,
        branch: z.string().optional().describe('Default main.'),
        limit: z.number().int().optional().describe(`Default ${DEFAULT_COMMITS}, max ${MAX_PER_PAGE}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (raw: never): Promise<ToolResult> => {
      const args = raw as { owner?: string; repo?: string; branch?: string; limit?: number };
      let where;
      try {
        where = target(args);
      } catch (error) {
        return errorResult((error as Error).message);
      }

      const branch = args.branch?.trim() || 'main';
      if (!isValidRef(branch)) return errorResult(`"${branch}" is not a valid branch name.`);

      try {
        const { data } = await api.repos.listCommits({
          ...where,
          sha: branch,
          per_page: clampPerPage(args.limit, DEFAULT_COMMITS),
        });

        return dataResult(`github ${where.owner}/${where.repo} commits on ${branch}`, {
          repository: `${where.owner}/${where.repo}`,
          branch,
          count: data.length,
          commits: data.map((commit) => ({
            sha: commit.sha.slice(0, 7),
            // First line only: a commit body can be hundreds of lines, and
            // this goes into a prompt.
            message: commit.commit.message.split(String.fromCharCode(10))[0],
            author: commit.commit.author?.name ?? 'unknown',
            date: commit.commit.author?.date,
            url: commit.html_url,
          })),
        });
      } catch (error) {
        return errorResult(describeGitHubError(error, `${where.owner}/${where.repo}@${branch}`));
      }
    },
  );

  registerTool(
    'trigger_workflow',
    {
      title: 'Trigger a GitHub Actions workflow',
      description:
        'Dispatch a workflow. This runs real CI and can deploy. Requires ' +
        'GITHUB_ALLOW_WRITES and a token with workflow scope.',
      inputSchema: {
        ...repoShape,
        workflowId: z.string().describe('Workflow file name, e.g. deploy.yml, or its numeric id.'),
        ref: z.string().optional().describe('Branch or tag to run on. Default main.'),
        inputs: z.record(z.string()).optional().describe('Workflow inputs.'),
      },
      // The daemon's approval gate keys off this: not read-only, and it causes
      // something to happen that cannot be taken back.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (raw: never): Promise<ToolResult> => {
      const args = raw as {
        owner?: string;
        repo?: string;
        workflowId: string;
        ref?: string;
        inputs?: Record<string, string>;
      };
      if (!writesAllowed(env)) return errorResult(WRITES_DISABLED);

      let where;
      try {
        where = target(args);
      } catch (error) {
        return errorResult((error as Error).message);
      }

      const workflowId = args.workflowId?.trim() ?? '';
      if (!isValidWorkflowId(workflowId)) {
        return errorResult(`"${workflowId}" is not a workflow file name or id.`);
      }
      const ref = args.ref?.trim() || 'main';
      if (!isValidRef(ref)) return errorResult(`"${ref}" is not a valid git ref.`);

      try {
        await api.actions.createWorkflowDispatch({
          ...where,
          workflow_id: workflowId,
          ref,
          inputs: args.inputs ?? {},
        });
        return dataResult(`github ${where.owner}/${where.repo} workflow dispatched`, {
          repository: `${where.owner}/${where.repo}`,
          workflow: workflowId,
          ref,
          dispatched: true,
          // Dispatch returns 204 with no body, so there is no run id to report.
          note: 'GitHub accepted the dispatch. Use ci_status to see the result.',
        });
      } catch (error) {
        return errorResult(describeGitHubError(error, `${where.owner}/${where.repo} ${workflowId}`));
      }
    },
  );

  registerTool(
    'create_issue',
    {
      title: 'Open an issue',
      description: 'Create a GitHub issue. Requires GITHUB_ALLOW_WRITES.',
      inputSchema: {
        ...repoShape,
        title: z.string().describe('Issue title.'),
        body: z.string().optional().describe('Issue body, markdown.'),
        labels: z.array(z.string()).optional().describe('Labels to apply.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (raw: never): Promise<ToolResult> => {
      const args = raw as {
        owner?: string;
        repo?: string;
        title: string;
        body?: string;
        labels?: string[];
      };
      if (!writesAllowed(env)) return errorResult(WRITES_DISABLED);

      let where;
      try {
        where = target(args);
      } catch (error) {
        return errorResult((error as Error).message);
      }

      const title = args.title?.trim() ?? '';
      if (title === '') return errorResult('An issue needs a title.');
      if (title.length > 256) return errorResult('That issue title is too long (max 256 characters).');

      try {
        const { data } = await api.issues.create({
          ...where,
          title,
          body: args.body,
          labels: args.labels,
        });
        return dataResult(`github ${where.owner}/${where.repo} issue created`, {
          repository: `${where.owner}/${where.repo}`,
          number: data.number,
          url: data.html_url,
        });
      } catch (error) {
        return errorResult(describeGitHubError(error, `${where.owner}/${where.repo}`));
      }
    },
  );
}

/**
 * Say what went wrong without relaying GitHub's own error.
 *
 * A raw Octokit error includes the request URL and headers, which carry the
 * token's scopes and sometimes the token itself in a retry context.
 */
export function describeGitHubError(error: unknown, subject: string): string {
  const status = (error as { status?: number }).status;
  const message = String((error as Error)?.message ?? error);

  switch (status) {
    case 401:
      return 'GitHub rejected the token. Check GITHUB_TOKEN is set and has not expired.';
    case 403:
      if (/rate limit/i.test(message)) {
        return 'GitHub rate limit reached. Wait a few minutes, or set GITHUB_TOKEN to raise the limit.';
      }
      return `The token is not allowed to do that on ${subject}. Check its scopes.`;
    case 404:
      return `Not found: ${subject}. Either it does not exist or the token cannot see it.`;
    case 422:
      return `GitHub refused that as invalid for ${subject}. A workflow must have a workflow_dispatch trigger to be dispatched.`;
    default:
      break;
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
    return 'Could not reach GitHub. Check the network and try again.';
  }
  return `The GitHub request for ${subject} failed.`;
}

/**
 * Build an Octokit client.
 *
 * `@octokit/rest` v22 is ESM-only with no CommonJS build. `require()` happens to
 * work on Node 22.12+ through require(esm), but this package supports Node 20,
 * where it throws ERR_REQUIRE_ESM — so it is reached by dynamic import, built
 * with `new Function` because TypeScript rewrites `import()` to `require()`
 * under `module: commonjs`.
 *
 * The token is optional: public repositories answer without one, at a lower
 * rate limit.
 */
export async function createOctokit(
  env: Record<string, string | undefined> = process.env,
): Promise<GitHubApi> {
  const importEsm = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<{ Octokit: new (options: Record<string, unknown>) => GitHubApi }>;

  const { Octokit } = await importEsm('@octokit/rest');
  const token = env.GITHUB_TOKEN?.trim();

  return new Octokit({
    auth: token || undefined,
    userAgent: `vigyl-mcp-github/${VERSION}`,
    request: { timeout: 15_000 },
  });
}

async function main(): Promise<void> {
  const api = await createOctokit();
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  registerGitHubTools(server, api);

  await server.connect(new StdioServerTransport());

  const scope = process.env.GITHUB_REPO?.trim();
  const auth = process.env.GITHUB_TOKEN ? 'with a token' : 'unauthenticated (public repos only)';
  const writes = writesAllowed() ? 'writes ENABLED' : 'read-only';
  process.stderr.write(
    `${SERVER_NAME} ready ${auth}, ${writes}${scope ? `, default repo ${scope}` : ''}\n`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${SERVER_NAME} failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
