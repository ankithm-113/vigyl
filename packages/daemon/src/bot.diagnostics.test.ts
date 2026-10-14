/**
 * `/mcp` and `/stats`.
 *
 * Both renderers are pure, so these assert on the text a person actually sees
 * rather than on a mocked Telegram call.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { formatUptime, renderMcp, renderStats } from './bot';
import type { DaemonStats, DaemonStatus } from './daemon';
import type { McpTool } from './mcp-guy';

const NL = String.fromCharCode(10);

function tool(name: string, serverId: string, readOnly = true): McpTool {
  return {
    name,
    serverId,
    description: `${name} does a thing`,
    inputSchema: {},
    readOnly,
    destructive: !readOnly,
  };
}

function stats(overrides: Partial<DaemonStats> = {}): DaemonStats {
  return {
    commandsRun: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolsByServer: {},
    selfHealAttempts: 0,
    selfHealSucceeded: 0,
    approvalsRequested: 0,
    approvalsGranted: 0,
    approvalsDenied: 0,
    uptimeMs: 0,
    ...overrides,
  };
}

function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    running: true,
    busy: false,
    version: '0.1.0',
    workspaceRoot: '/srv/app',
    model: 'gpt-4o-mini',
    pendingApprovals: 0,
    mcpServers: [],
    mcpTools: [],
    ...overrides,
  };
}

describe('formatUptime', () => {
  it('reads the way a person would say it', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(47_000), '47s');
    assert.equal(formatUptime(125_000), '2m 5s');
    assert.equal(formatUptime(7_500_000), '2h 5m');
    assert.equal(formatUptime(311_040_000), '3d 14h');
  });

  it('does not render a negative or absurd duration', () => {
    assert.equal(formatUptime(-5), '0s');
    assert.equal(formatUptime(500), '0s');
  });
});

describe('/mcp', () => {
  it('says what to do when nothing is connected', () => {
    const text = renderMcp([], []);
    assert.match(text, /No services connected/);
    assert.match(text, /mcp_servers/);
    assert.ok(!text.includes('🔒'), 'nothing to mark');
  });

  it('groups the tools under the server that owns them', () => {
    const text = renderMcp(
      ['firebase', 'github'],
      [
        tool('firestore_query', 'firebase'),
        tool('auth_user_count', 'firebase'),
        tool('list_prs', 'github'),
      ],
    );

    assert.match(text, /2 service\(s\) connected/);
    assert.match(text, /<b>firebase<\/b> — 2 tool\(s\)/);
    assert.match(text, /<b>github<\/b> — 1 tool\(s\)/);

    // firestore_query is listed under firebase, not github.
    const firebaseBlock = text.slice(text.indexOf('firebase'), text.indexOf('github'));
    assert.match(firebaseBlock, /firestore_query/);
    assert.ok(!firebaseBlock.includes('list_prs'));
  });

  it('marks the tools that will ask first, and explains the mark', () => {
    const text = renderMcp(
      ['github'],
      [tool('list_prs', 'github'), tool('trigger_workflow', 'github', false)],
    );

    const lines = text.split(NL);
    const gated = lines.find((line) => line.includes('trigger_workflow'));
    const open = lines.find((line) => line.includes('list_prs'));

    assert.match(gated ?? '', /🔒/);
    assert.ok(open !== undefined && !open.includes('🔒'), 'a read-only tool is not marked');
    assert.match(text, /asks for your approval/);
  });

  it('does not explain the padlock when nothing is gated', () => {
    const text = renderMcp(['database'], [tool('db_query', 'database')]);
    assert.ok(!text.includes('asks for your approval'));
  });

  it('escapes a server name rather than letting it become markup', () => {
    const text = renderMcp(['<b>evil</b>'], []);
    // No servers listed means the empty branch; check the tool path instead.
    const withTool = renderMcp(['<b>evil</b>'], [tool('x', '<b>evil</b>')]);
    assert.ok(!withTool.includes('<b>evil</b>'), 'a server name must not inject HTML');
    assert.match(withTool, /&lt;b&gt;evil/);
    assert.ok(text.length > 0);
  });
});

describe('/stats', () => {
  it('shows only what has happened', () => {
    const text = renderStats(stats({ commandsRun: 3, uptimeMs: 65_000 }), status());

    assert.match(text, /Uptime: 1m 5s/);
    assert.match(text, /Commands: 3/);
    // Nothing has healed, been approved or called a service, so none of those
    // lines appear — a wall of zeroes tells you nothing.
    assert.ok(!text.includes('Self-heals'));
    assert.ok(!text.includes('Approvals'));
    assert.ok(!text.includes('Service calls'));
  });

  it('reports self-healing with how many actually worked', () => {
    const text = renderStats(
      stats({ commandsRun: 10, selfHealAttempts: 8, selfHealSucceeded: 6 }),
      status(),
    );
    assert.match(text, /Self-heals: 8 \(6 succeeded\)/);
  });

  it('reports approvals asked, granted and denied', () => {
    const text = renderStats(
      stats({ approvalsRequested: 5, approvalsGranted: 3, approvalsDenied: 2 }),
      status(),
    );
    assert.match(text, /Approvals: 5 asked · 3 granted · 2 denied/);
  });

  it('breaks service calls down per server, so a noisy one is visible', () => {
    const text = renderStats(
      stats({
        toolCalls: 36,
        toolsByServer: { firebase: 18, github: 11, database: 7 },
      }),
      status({ mcpServers: ['firebase', 'github', 'database'] }),
    );

    assert.match(text, /Service calls: 36/);
    assert.match(text, /firebase: 18/);
    assert.match(text, /github: 11/);
    assert.match(text, /database: 7/);
  });

  it('counts failed service calls rather than hiding them', () => {
    const text = renderStats(
      stats({ toolCalls: 10, toolErrors: 3, toolsByServer: { github: 10 } }),
      status({ mcpServers: ['github'] }),
    );
    assert.match(text, /Service calls: 10 \(3 failed\)/);
  });

  it('says "none yet" when services are connected but unused', () => {
    const text = renderStats(stats(), status({ mcpServers: ['firebase'] }));
    assert.match(text, /Service calls: none yet/);
  });

  it('mentions approvals that are still waiting', () => {
    const text = renderStats(stats(), status({ pendingApprovals: 2 }));
    assert.match(text, /2 approval\(s\) waiting/);
  });

  it('says the numbers reset, so a restart is not mysterious', () => {
    assert.match(renderStats(stats(), status()), /since the daemon last started/);
  });

  it('escapes a server name in the breakdown', () => {
    const text = renderStats(
      stats({ toolCalls: 1, toolsByServer: { '<img src=x>': 1 } }),
      status({ mcpServers: ['<img src=x>'] }),
    );
    assert.ok(!text.includes('<img src=x>'));
  });
});
