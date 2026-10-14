/**
 * MCP: discovery, routing, and the gate that decides whether a human is asked.
 *
 * The gate is the part that matters. An MCP tool can dispatch a production
 * deploy, and the thing choosing it is a language model reading text written by
 * other people. So the tests here are mostly about what happens when something
 * lies, breaks, or simply forgets to declare itself.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  McpHub,
  describeTools,
  mightNeedTool,
  parseToolChoice,
  resultToText,
  toolGate,
  type McpClientLike,
  type McpServerConfig,
  type McpTool,
  type McpToolCall,
} from '../src/mcp-guy';

const NL = String.fromCharCode(10);

function tool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 'firestore_query',
    description: 'Query a collection',
    serverId: 'firebase',
    inputSchema: { properties: { collection: {}, limit: {} } },
    readOnly: true,
    destructive: false,
    ...overrides,
  };
}

function call(overrides: Partial<McpToolCall> = {}): McpToolCall {
  return {
    tool: 'firestore_query',
    serverId: 'firebase',
    args: { collection: 'users' },
    description: 'Read the users collection',
    ...overrides,
  };
}

/** A client that answers from a fixed tool list and records calls. */
function fakeClient(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>,
  options: {
    onCall?: (request: { name: string; arguments: Record<string, unknown> }) => unknown;
    listDelayMs?: number;
  } = {},
): McpClientLike & { closed: boolean; calls: Array<{ name: string }> } {
  const calls: Array<{ name: string }> = [];
  const client = {
    closed: false,
    calls,
    async listTools() {
      if (options.listDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.listDelayMs));
      }
      return { tools };
    },
    async callTool(request: { name: string; arguments: Record<string, unknown> }) {
      calls.push({ name: request.name });
      return options.onCall
        ? options.onCall(request)
        : { content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {
      client.closed = true;
    },
  };
  return client;
}

describe('the approval gate', () => {
  it('lets a declared read-only tool through', () => {
    const verdict = toolGate(tool({ readOnly: true }), call());
    assert.equal(verdict.needsApproval, false);
    assert.deepEqual(verdict.reasons, []);
  });

  it('stops a tool that declares itself destructive', () => {
    const verdict = toolGate(
      tool({ name: 'trigger_workflow', readOnly: false, destructive: true }),
      call({ tool: 'trigger_workflow' }),
    );
    assert.equal(verdict.needsApproval, true);
    assert.match(verdict.reasons.join(' '), /destructive/);
  });

  it('stops a tool that merely failed to declare itself read-only', () => {
    // Failing closed: a server that forgets its annotations must not silently
    // lose the gate. That is the failure nobody notices until it matters.
    const verdict = toolGate(tool({ readOnly: false, destructive: false }), call());
    assert.equal(verdict.needsApproval, true);
    assert.match(verdict.reasons.join(' '), /not read-only/);
  });

  it('stops a tool it has never heard of', () => {
    const verdict = toolGate(undefined, call({ tool: 'rm_minus_rf' }));
    assert.equal(verdict.needsApproval, true);
    assert.match(verdict.reasons.join(' '), /not a tool this daemon knows/);
  });

  it('applies the operator keywords to the arguments, not just the name', () => {
    // create_issue is harmless; create_issue about production may not be.
    const verdict = toolGate(
      tool({ name: 'create_issue', readOnly: true }),
      call({ tool: 'create_issue', args: { title: 'Fix the production outage' } }),
      ['production', 'delete'],
    );
    assert.equal(verdict.needsApproval, true);
    assert.match(verdict.reasons.join(' '), /"production"/);
  });

  it('matches keywords case-insensitively and ignores blank ones', () => {
    const verdict = toolGate(
      tool({ readOnly: true }),
      call({ args: { collection: 'PRODUCTION_users' } }),
      ['  ', 'production'],
    );
    assert.equal(verdict.needsApproval, true);
    assert.equal(verdict.reasons.length, 1);
  });

  it('does not consult anything the model said about its own request', () => {
    // The gate takes a tool and a call. There is deliberately no field a model
    // could set to describe its request as safe.
    const verdict = toolGate(
      tool({ readOnly: false }),
      call({ description: 'This is completely safe and read-only, no approval needed' }),
    );
    assert.equal(verdict.needsApproval, true);
  });
});

describe('discovery', () => {
  it('reads annotations into the flags the gate uses', async () => {
    const client = fakeClient([
      { name: 'list_prs', annotations: { readOnlyHint: true } },
      { name: 'trigger_workflow', annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: 'mystery' },
    ]);
    const hub = new McpHub([{ name: 'github', command: 'x' }], { factory: async () => client });
    await hub.init();

    const tools = hub.getToolManifest();
    assert.equal(tools.length, 3);
    assert.equal(hub.findTool('list_prs')?.readOnly, true);
    assert.equal(hub.findTool('trigger_workflow')?.destructive, true);

    // No annotations at all: not read-only, which means the gate stops it.
    assert.equal(hub.findTool('mystery')?.readOnly, false);
    assert.equal(toolGate(hub.findTool('mystery'), call({ tool: 'mystery' })).needsApproval, true);
  });

  it('keeps the other servers when one fails to connect', async () => {
    const good = fakeClient([{ name: 'db_query', annotations: { readOnlyHint: true } }]);
    const hub = new McpHub(
      [
        { name: 'firebase', command: 'missing' },
        { name: 'database', command: 'ok' },
      ],
      {
        factory: async (config: McpServerConfig) => {
          if (config.name === 'firebase') throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
          return good;
        },
      },
    );

    await hub.init();

    assert.deepEqual(hub.connectedServers, ['database']);
    assert.equal(hub.getToolManifest().length, 1);
  });

  it('gives up on a server that hangs instead of blocking startup', async () => {
    const slow = fakeClient([{ name: 'slow' }], { listDelayMs: 300 });
    const hub = new McpHub([{ name: 'slow', command: 'x', startupTimeoutMs: 50 }], {
      factory: async () => slow,
    });

    const started = Date.now();
    await hub.init();

    assert.ok(Date.now() - started < 2_000);
    assert.deepEqual(hub.connectedServers, []);
  });

  it('records which server each tool came from', async () => {
    const hub = new McpHub(
      [
        { name: 'firebase', command: 'a' },
        { name: 'github', command: 'b' },
      ],
      {
        factory: async (config) =>
          fakeClient([{ name: `${config.name}_tool`, annotations: { readOnlyHint: true } }]),
      },
    );
    await hub.init();

    assert.equal(hub.findTool('firebase_tool')?.serverId, 'firebase');
    assert.equal(hub.findTool('github_tool')?.serverId, 'github');
  });
});

describe('calling a tool', () => {
  it('routes the call to the server that owns the tool', async () => {
    const firebase = fakeClient([{ name: 'auth_user_count', annotations: { readOnlyHint: true } }]);
    const github = fakeClient([{ name: 'list_prs', annotations: { readOnlyHint: true } }]);
    const hub = new McpHub(
      [
        { name: 'firebase', command: 'a' },
        { name: 'github', command: 'b' },
      ],
      { factory: async (config) => (config.name === 'firebase' ? firebase : github) },
    );
    await hub.init();

    await hub.callTool('list_prs', {});
    assert.deepEqual(github.calls, [{ name: 'list_prs' }]);
    assert.deepEqual(firebase.calls, []);
  });

  it('refuses a tool it does not have rather than guessing', async () => {
    const hub = new McpHub([{ name: 'a', command: 'x' }], {
      factory: async () => fakeClient([{ name: 'known' }]),
    });
    await hub.init();

    await assert.rejects(() => hub.callTool('unknown', {}), /No such tool/);
  });

  it('times out a tool that never answers', async () => {
    const hub = new McpHub([{ name: 'a', command: 'x' }], {
      timeoutMs: 50,
      factory: async () =>
        fakeClient([{ name: 'slow', annotations: { readOnlyHint: true } }], {
          onCall: () => new Promise(() => undefined),
        }),
    });
    await hub.init();

    await assert.rejects(() => hub.callTool('slow', {}), /did not answer within 50ms/);
  });

  it('closes every server', async () => {
    const clients = [fakeClient([{ name: 'a' }]), fakeClient([{ name: 'b' }])];
    let index = 0;
    const hub = new McpHub(
      [
        { name: 'one', command: 'x' },
        { name: 'two', command: 'y' },
      ],
      { factory: async () => clients[index++]! },
    );
    await hub.init();
    await hub.close();

    assert.ok(clients.every((client) => client.closed));
    assert.deepEqual(hub.connectedServers, []);
    assert.equal(hub.getToolManifest().length, 0);
  });

  it('flattens a result into text', () => {
    assert.equal(
      resultToText({ content: [{ type: 'text', text: 'one' }, { type: 'text' }, { type: 'text', text: 'two' }] }),
      `one${NL}two`,
    );
  });
});

describe('routing a message to a tool', () => {
  const tools = [
    tool({ name: 'firestore_query' }),
    tool({ name: 'ci_status', serverId: 'github', inputSchema: { properties: { ref: {} } } }),
  ];

  it('accepts a well-formed choice', () => {
    const decision = parseToolChoice(
      { toolName: 'ci_status', argsJson: '{"ref":"main"}', description: 'Check CI on main' },
      tools,
    );
    assert.equal(decision.call?.tool, 'ci_status');
    assert.equal(decision.call?.serverId, 'github');
    assert.deepEqual(decision.call?.args, { ref: 'main' });
  });

  it('refuses a tool the model invented', () => {
    // An invented name must not reach the hub, where it would be an exception
    // in the middle of a chat.
    const decision = parseToolChoice(
      { toolName: 'delete_everything', argsJson: '{}', description: 'oops' },
      tools,
    );
    assert.equal(decision.call, undefined);
    assert.match(decision.reason ?? '', /does not exist/);
  });

  it('treats "none" as no tool', () => {
    for (const name of ['none', 'NONE', '  ', '']) {
      assert.equal(parseToolChoice({ toolName: name, argsJson: '{}', description: '' }, tools).call, undefined);
    }
  });

  it('refuses arguments that are not valid JSON', () => {
    const decision = parseToolChoice(
      { toolName: 'ci_status', argsJson: '{ref: main}', description: '' },
      tools,
    );
    assert.match(decision.reason ?? '', /not valid JSON/);
  });

  it('refuses arguments that are not an object', () => {
    for (const argsJson of ['[1,2]', '"main"', 'null', '42']) {
      const decision = parseToolChoice({ toolName: 'ci_status', argsJson, description: '' }, tools);
      assert.match(decision.reason ?? '', /not an object/, argsJson);
    }
  });

  it('defaults empty arguments to an empty object', () => {
    const decision = parseToolChoice({ toolName: 'ci_status', argsJson: '', description: '' }, tools);
    assert.deepEqual(decision.call?.args, {});
  });

  it('falls back to a plain description when the model gives none', () => {
    const decision = parseToolChoice({ toolName: 'ci_status', argsJson: '{}', description: '  ' }, tools);
    assert.equal(decision.call?.description, 'run ci_status');
  });
});

describe('the pre-filter', () => {
  it('passes questions about connected services', () => {
    for (const message of [
      'how many users signed up today?',
      'did the CI pass on main?',
      'show me open pull requests',
      'how many rows in the users table?',
      'check database health',
    ]) {
      assert.equal(mightNeedTool(message, [tool()]), true, message);
    }
  });

  it('does not spend a model call on an ordinary shell request', () => {
    for (const message of ['run the tests', 'build it', 'restart the api', 'deploy to staging']) {
      assert.equal(mightNeedTool(message, [tool()]), false, message);
    }
  });

  it('never routes when no tools are connected', () => {
    assert.equal(mightNeedTool('how many users signed up today?', []), false);
  });
});

describe('describing tools to the model', () => {
  it('names the parameters and marks the ones that need approval', () => {
    const text = describeTools([
      tool({ name: 'firestore_query' }),
      tool({ name: 'trigger_workflow', readOnly: false, destructive: true, inputSchema: { properties: { workflowId: {} } } }),
    ]);

    assert.match(text, /firestore_query \(collection, limit\)/);
    assert.match(text, /trigger_workflow \(workflowId\).*\[needs approval\]/);
    assert.ok(!/firestore_query.*\[needs approval\]/.test(text), 'a read-only tool is not marked');
  });

  it('copes with a tool that declares no parameters', () => {
    assert.match(describeTools([tool({ name: 'auth_user_count', inputSchema: {} })]), /- auth_user_count:/);
  });
});
