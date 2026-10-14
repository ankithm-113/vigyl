import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DaemonNotStartedError, VigylDaemon, type CommandResult } from './daemon';
import { Executor } from './executor';
import type { Supervisor, ParsedCommand, UnvalidatedPatch } from './supervisor';
import type { VigylConfig } from './config';

let workspace: string;

const noop = (): void => {
  /* progress output is not under test */
};

function command(overrides: Partial<ParsedCommand> = {}): ParsedCommand {
  return {
    action: 'build',
    target: 'api',
    command: 'node ok.js',
    isDestructive: false,
    description: 'Build the API.',
    requiresApproval: false,
    ...overrides,
  };
}

class FakeSupervisor {
  public parseCalls = 0;
  public patchCalls = 0;
  private readonly parses: Array<ParsedCommand | Error>;
  private readonly patches: Array<UnvalidatedPatch | undefined>;

  constructor(parses: Array<ParsedCommand | Error>, patches: Array<UnvalidatedPatch | undefined> = []) {
    this.parses = parses;
    this.patches = patches;
  }

  public readonly contexts: Array<string | undefined> = [];

  async parseCommand(_message: string, context?: { recentOutput?: string }): Promise<ParsedCommand> {
    this.parseCalls++;
    this.contexts.push(context?.recentOutput);
    const next = this.parses.shift();
    if (next === undefined) throw new Error('FakeSupervisor: no parse queued');
    if (next instanceof Error) throw next;
    return next;
  }

  async generatePatch(): Promise<UnvalidatedPatch | undefined> {
    this.patchCalls++;
    return this.patches.shift();
  }
}

function makeConfig(overrides: Partial<VigylConfig> = {}): VigylConfig {
  return {
    workspace_root: workspace,
    telegram: { bot_token: '1:x', allowed_chat_ids: [1] },
    provider: 'anthropic',
    anthropic: { api_key: 'sk-ant-test', model: 'claude-haiku-4-5' },
    mcp_servers: [],
    hitl: { require_for: ['production', 'delete', 'push'], timeout_seconds: 300 },
    self_heal: { enabled: true, max_retries: 3, context_lines: 80 },
    monitor: {
      enabled: false,
      interval_seconds: 300,
      cooldown_seconds: 3600,
      cpu_percent: 90,
      memory_percent: 90,
      disk_percent: 85,
      services: [],
    },
    daemon: { log_level: 'error', log_retention_days: 7 },
    ...overrides,
  };
}

async function startedDaemon(
  supervisor: FakeSupervisor,
  config: VigylConfig = makeConfig(),
): Promise<VigylDaemon> {
  const daemon = new VigylDaemon(config, { supervisor: supervisor as unknown as Supervisor, stateDir: path.join(workspace, ".vigyl") });
  await daemon.start();
  return daemon;
}

beforeEach(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-daemon-')));
  fs.writeFileSync(path.join(workspace, 'ok.js'), 'console.log("ok");');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('lifecycle', () => {
  it('reports status before and after start', async () => {
    const daemon = new VigylDaemon(makeConfig(), {
      supervisor: new FakeSupervisor([]) as unknown as Supervisor,
      stateDir: path.join(workspace, ".vigyl"),
    });

    assert.equal(daemon.status.running, false);
    await daemon.start();
    assert.equal(daemon.status.running, true);
    assert.equal(daemon.status.workspaceRoot, workspace);
    assert.equal(typeof daemon.status.startedAt, 'number');

    await daemon.stop();
    assert.equal(daemon.status.running, false);
  });

  it('refuses to handle a command before it is started', async () => {
    const daemon = new VigylDaemon(makeConfig(), {
      supervisor: new FakeSupervisor([command()]) as unknown as Supervisor,
      stateDir: path.join(workspace, ".vigyl"),
    });

    await assert.rejects(() => daemon.handleCommand('build', noop), DaemonNotStartedError);
  });

  it('is idempotent on repeated start and stop', async () => {
    const daemon = await startedDaemon(new FakeSupervisor([]));
    await daemon.start();
    assert.equal(daemon.status.running, true);
    await daemon.stop();
    await daemon.stop();
    assert.equal(daemon.status.running, false);
  });

  it('fails to start when the workspace has disappeared', async () => {
    const config = makeConfig();
    const daemon = new VigylDaemon(config, {
      supervisor: new FakeSupervisor([]) as unknown as Supervisor,
      stateDir: path.join(workspace, ".vigyl"),
    });
    fs.rmSync(workspace, { recursive: true, force: true });

    await assert.rejects(() => daemon.start(), /no longer exists/);
    fs.mkdirSync(workspace, { recursive: true });
  });
});

describe('structured results', () => {
  it('returns a completed result, not a string', async () => {
    const daemon = await startedDaemon(new FakeSupervisor([command()]));

    const result = await daemon.handleCommand('build it', noop);

    // The whole point: callers switch on status, never match on prose.
    assert.equal(result.status, 'completed');
    assert.equal(typeof result, 'object');
    if (result.status !== 'completed') throw new Error('narrowing');
    assert.equal(result.exitCode, 0);
    assert.equal(result.command, 'node ok.js');
    assert.equal(result.attempts, 1);
    await daemon.stop();
  });

  it('reports a parse failure as error, not as a failed command', async () => {
    const daemon = await startedDaemon(new FakeSupervisor([new Error('anthropic is down')]));

    const result = await daemon.handleCommand('build it', noop);

    assert.equal(result.status, 'error');
    if (result.status !== 'error') throw new Error('narrowing');
    assert.match(result.reason, /anthropic is down/);
    await daemon.stop();
  });

  it('rejects a command that violates policy without running it', async () => {
    const daemon = await startedDaemon(
      new FakeSupervisor([command({ command: 'sudo rm -rf /var' })]),
    );

    const result = await daemon.handleCommand('clean up', noop);

    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') throw new Error('narrowing');
    assert.match(result.reason, /security policy/i);
    await daemon.stop();
  });

  it('distinguishes a failed command from an internal error', async () => {
    fs.writeFileSync(path.join(workspace, 'bad.js'), 'process.exit(4);');
    const daemon = await startedDaemon(
      new FakeSupervisor([command({ command: 'node bad.js' })], [undefined]),
    );

    const result = await daemon.handleCommand('run it', noop);

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('narrowing');
    assert.equal(result.exitCode, 4);
    assert.ok(typeof result.reason === 'string');
    await daemon.stop();
  });
});

describe('approval gate', () => {
  it('returns an approval handle instead of a sentence to grep for', async () => {
    const daemon = await startedDaemon(
      new FakeSupervisor([command({ command: 'npm run deploy:production', requiresApproval: true })]),
    );

    const result = await daemon.handleCommand('deploy to production', noop);

    assert.equal(result.status, 'approval_required');
    if (result.status !== 'approval_required') throw new Error('narrowing');
    assert.equal(typeof result.approvalId, 'string');
    assert.ok(result.approvalId.length > 0);
    assert.ok(result.reasons.length > 0);
    assert.ok(result.expiresAt > Date.now());
    await daemon.stop();
  });

  it('flags approval from the config triggers even when Claude does not', async () => {
    // The model can be talked out of setting requiresApproval by the very
    // message it is parsing, so the operator's own keyword rules run too.
    const daemon = await startedDaemon(
      new FakeSupervisor([
        command({ command: 'git push origin main', requiresApproval: false, isDestructive: false }),
      ]),
    );

    const result = await daemon.handleCommand('ship it', noop);

    assert.equal(result.status, 'approval_required');
    if (result.status !== 'approval_required') throw new Error('narrowing');
    assert.ok(result.reasons.some((r) => r.includes('push')));
    await daemon.stop();
  });

  it('executes the stored command on approval without re-parsing', async () => {
    const supervisor = new FakeSupervisor([
      command({ command: 'node ok.js', requiresApproval: true }),
    ]);
    const daemon = await startedDaemon(supervisor);

    const gate = await daemon.handleCommand('do the thing', noop);
    assert.equal(gate.status, 'approval_required');
    if (gate.status !== 'approval_required') throw new Error('narrowing');

    const result = await daemon.approve(gate.approvalId, noop);

    assert.equal(result.status, 'completed');
    // The guide re-sent "message + ' --approved'" through the model here.
    // Exactly one parse means what ran is what the user was shown.
    assert.equal(supervisor.parseCalls, 1);
    await daemon.stop();
  });

  it('consumes the approval so it cannot be replayed', async () => {
    const daemon = await startedDaemon(
      new FakeSupervisor([command({ requiresApproval: true })]),
    );
    const gate = await daemon.handleCommand('do it', noop);
    if (gate.status !== 'approval_required') throw new Error('narrowing');

    await daemon.approve(gate.approvalId, noop);
    const replay = await daemon.approve(gate.approvalId, noop);

    assert.equal(replay.status, 'rejected');
    await daemon.stop();
  });

  it('denies and forgets a pending approval', async () => {
    const daemon = await startedDaemon(
      new FakeSupervisor([command({ requiresApproval: true })]),
    );
    const gate = await daemon.handleCommand('do it', noop);
    if (gate.status !== 'approval_required') throw new Error('narrowing');

    assert.equal(daemon.deny(gate.approvalId), true);
    assert.equal(daemon.deny(gate.approvalId), false);
    assert.equal(daemon.peekApproval(gate.approvalId), undefined);
    assert.equal(daemon.status.pendingApprovals, 0);
    await daemon.stop();
  });

  it('expires an approval after hitl.timeout_seconds', async () => {
    const daemon = await startedDaemon(
      new FakeSupervisor([command({ requiresApproval: true })]),
      makeConfig({ hitl: { require_for: [], timeout_seconds: 0 } }),
    );

    const gate = await daemon.handleCommand('do it', noop);
    if (gate.status !== 'approval_required') throw new Error('narrowing');

    const result = await daemon.approve(gate.approvalId, noop);

    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') throw new Error('narrowing');
    assert.match(result.reason, /expired|no longer valid/i);
    await daemon.stop();
  });

  it('will not let one owner approve another owner request', async () => {
    const daemon = await startedDaemon(
      new FakeSupervisor([command({ requiresApproval: true })]),
    );
    const gate = await daemon.handleCommand('do it', noop, { owner: 111 });
    if (gate.status !== 'approval_required') throw new Error('narrowing');

    const stolen = await daemon.approve(gate.approvalId, noop, { owner: 222 });

    assert.equal(stolen.status, 'rejected');
    assert.equal(daemon.deny(gate.approvalId, { owner: 222 }), false);
    // The rightful owner can still act on it.
    assert.equal(daemon.deny(gate.approvalId, { owner: 111 }), true);
    await daemon.stop();
  });

  it('drops pending approvals on stop', async () => {
    const daemon = await startedDaemon(
      new FakeSupervisor([command({ requiresApproval: true })]),
    );
    const gate = await daemon.handleCommand('do it', noop);
    if (gate.status !== 'approval_required') throw new Error('narrowing');
    assert.equal(daemon.status.pendingApprovals, 1);

    await daemon.stop();
    await daemon.start();

    assert.equal(daemon.status.pendingApprovals, 0);
    await daemon.stop();
  });
});

describe('integration: real executor, real self-healing', () => {
  it('runs a real command end to end', async () => {
    const supervisor = new FakeSupervisor([command({ command: 'node ok.js' })]);
    const config = makeConfig();
    const daemon = new VigylDaemon(config, {
      supervisor: supervisor as unknown as Supervisor,
      executor: new Executor(config),
      stateDir: path.join(workspace, '.vigyl'),
    });
    await daemon.start();

    const progress: string[] = [];
    const result = await daemon.handleCommand('run it', (m) => progress.push(m));

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('narrowing');
    assert.match(result.output, /ok/);
    assert.ok(progress.length > 0, 'progress should be reported');
    await daemon.stop();
  });

  it('patches a real file on disk and succeeds on the retry', async () => {
    // Genuinely broken: node exits non-zero with a syntax error naming the file.
    fs.writeFileSync(path.join(workspace, 'app.js'), 'const x = ;');

    const supervisor = new FakeSupervisor(
      [command({ command: 'node app.js' })],
      [{ filePath: 'app.js', contents: 'console.log("repaired");', explanation: 'Removed the stray token.' }],
    );
    const config = makeConfig();
    const daemon = new VigylDaemon(config, {
      supervisor: supervisor as unknown as Supervisor,
      executor: new Executor(config),
      stateDir: path.join(workspace, '.vigyl'),
    });
    await daemon.start();

    const result = await daemon.handleCommand('run the app', noop);

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('narrowing');
    assert.equal(result.attempts, 2);
    assert.equal(result.patches.length, 1);
    assert.match(result.output, /repaired/);
    // The file really changed, and the original is recoverable.
    assert.equal(fs.readFileSync(path.join(workspace, 'app.js'), 'utf-8'), 'console.log("repaired");');
    const backup = result.patches[0]?.backupPath;
    assert.ok(backup !== undefined);
    assert.equal(fs.readFileSync(backup, 'utf-8'), 'const x = ;');
    await daemon.stop();
  });

  it('refuses a patch that escapes the workspace, through the whole pipeline', async () => {
    fs.writeFileSync(path.join(workspace, 'app.js'), 'const x = ;');
    const victim = path.join(path.dirname(workspace), 'victim.txt');
    fs.writeFileSync(victim, 'UNTOUCHED');

    const supervisor = new FakeSupervisor(
      [command({ command: 'node app.js' })],
      [{ filePath: path.join('..', 'victim.txt'), contents: 'PWNED', explanation: 'fix' }],
    );
    const config = makeConfig();
    const daemon = new VigylDaemon(config, {
      supervisor: supervisor as unknown as Supervisor,
      executor: new Executor(config),
      stateDir: path.join(workspace, '.vigyl'),
    });
    await daemon.start();

    const result = await daemon.handleCommand('run the app', noop);

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('narrowing');
    assert.equal(result.reason, 'patch_rejected');
    assert.equal(fs.readFileSync(victim, 'utf-8'), 'UNTOUCHED');
    fs.rmSync(victim, { force: true });
    await daemon.stop();
  });

  it('reports busy rather than interleaving two commands', async () => {
    fs.writeFileSync(path.join(workspace, 'slow.js'), 'setTimeout(() => process.exit(0), 2500);');
    const supervisor = new FakeSupervisor([
      command({ command: 'node slow.js' }),
      command({ command: 'node ok.js' }),
    ]);
    const config = makeConfig();
    const daemon = new VigylDaemon(config, {
      supervisor: supervisor as unknown as Supervisor,
      executor: new Executor(config),
      stateDir: path.join(workspace, '.vigyl'),
    });
    await daemon.start();

    const first = daemon.handleCommand('slow one', noop);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const second: CommandResult = await daemon.handleCommand('quick one', noop);

    assert.equal(second.status, 'busy');
    const firstResult = await first;
    assert.equal(firstResult.status, 'completed');
    await daemon.stop();
  });
});

describe('session context', () => {
  it('sends no context on the first message of a chat', async () => {
    const supervisor = new FakeSupervisor([command()]);
    const daemon = await startedDaemon(supervisor);

    await daemon.handleCommand('build it', noop, { owner: 111 });

    assert.equal(supervisor.contexts[0], undefined);
    await daemon.stop();
  });

  it('feeds the previous turn back as context on the next message', async () => {
    const supervisor = new FakeSupervisor([command(), command()]);
    const daemon = await startedDaemon(supervisor);

    await daemon.handleCommand('build it', noop, { owner: 111 });
    await daemon.handleCommand('run that again', noop, { owner: 111 });

    const second = supervisor.contexts[1];
    assert.ok(second !== undefined, "second call should carry context");
    assert.match(second, /node ok.js/);
    assert.match(second, /build it/);
    await daemon.stop();
  });

  it('never leaks one chat context into another chat parse', async () => {
    // The failure that matters: not merely reading someone else history,
    // but having their output steer the model on your message.
    const supervisor = new FakeSupervisor([
      command({ command: 'node ok.js', description: 'ALICE-PRIVATE' }),
      command(),
    ]);
    const daemon = await startedDaemon(supervisor);

    await daemon.handleCommand('alice secret', noop, { owner: 111 });
    await daemon.handleCommand('bob message', noop, { owner: 222 });

    assert.equal(supervisor.contexts[1], undefined, "bob must start with a clean slate");
    await daemon.stop();
  });

  it('keeps per-chat history separate and queryable', async () => {
    const supervisor = new FakeSupervisor([command(), command()]);
    const daemon = await startedDaemon(supervisor);

    await daemon.handleCommand('alice', noop, { owner: 111 });
    await daemon.handleCommand('bob', noop, { owner: 222 });

    assert.equal(daemon.sessionTurns(111).length, 1);
    assert.equal(daemon.sessionTurns(222).length, 1);
    assert.equal(daemon.sessionTurns(111)[0]?.userMessage, 'alice');
    assert.equal(daemon.sessionTurns(222)[0]?.userMessage, 'bob');
    await daemon.stop();
  });

  it('records a refusal too, so the next turn knows it was blocked', async () => {
    const supervisor = new FakeSupervisor([
      command({ command: 'sudo rm -rf /var' }),
    ]);
    const daemon = await startedDaemon(supervisor);

    await daemon.handleCommand('clean up', noop, { owner: 111 });

    const history = daemon.sessionTurns(111);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.status, 'rejected');
    await daemon.stop();
  });

  it('keeps no session at all when there is no owner', async () => {
    // A shared bucket for anonymous callers would be a cross-chat leak
    // waiting to happen, so no owner means no history.
    const supervisor = new FakeSupervisor([command(), command()]);
    const daemon = await startedDaemon(supervisor);

    await daemon.handleCommand('one', noop);
    await daemon.handleCommand('two', noop);

    assert.equal(supervisor.contexts[1], undefined);
    await daemon.stop();
  });

  it('forgets a chat on request and drops all sessions on stop', async () => {
    const supervisor = new FakeSupervisor([command(), command()]);
    const daemon = await startedDaemon(supervisor);
    await daemon.handleCommand('alice', noop, { owner: 111 });
    await daemon.handleCommand('bob', noop, { owner: 222 });

    assert.equal(daemon.forget(111), true);
    assert.equal(daemon.sessionTurns(111).length, 0);
    assert.equal(daemon.sessionTurns(222).length, 1);

    await daemon.stop();
    assert.equal(daemon.sessionTurns(222).length, 0);
  });
});

describe('repeat', () => {
  it('re-enters the supervisor pipeline instead of replaying the shell string', async () => {
    const supervisor = new FakeSupervisor([command(), command()]);
    const daemon = await startedDaemon(supervisor);
    await daemon.handleCommand('build the api', noop, { owner: 111 });

    const result = await daemon.repeat(111, noop);

    assert.equal(result.status, 'completed');
    // Two parses: the original and the repeat. Replaying the stored shell
    // command directly would have skipped the second.
    assert.equal(supervisor.parseCalls, 2);
    await daemon.stop();
  });

  it('re-applies the approval gate when repeating a destructive command', async () => {
    const supervisor = new FakeSupervisor([
      command({ command: 'npm run deploy:production', requiresApproval: true }),
      command({ command: 'npm run deploy:production', requiresApproval: true }),
    ]);
    const daemon = await startedDaemon(supervisor);

    const first = await daemon.handleCommand('deploy to production', noop, { owner: 111 });
    assert.equal(first.status, 'approval_required');
    if (first.status !== 'approval_required') throw new Error('narrowing');
    await daemon.approve(first.approvalId, noop, { owner: 111 });

    const repeated = await daemon.repeat(111, noop);

    // The whole point: repeating a production deploy still asks.
    assert.equal(repeated.status, 'approval_required');
    await daemon.stop();
  });

  it('reports there is nothing to repeat in a fresh chat', async () => {
    const daemon = await startedDaemon(new FakeSupervisor([]));

    const result = await daemon.repeat(111, noop);

    assert.equal(result.status, 'rejected');
    await daemon.stop();
  });

  it('keeps durable history isolated per chat', async () => {
    const supervisor = new FakeSupervisor([command(), command()]);
    const daemon = await startedDaemon(supervisor);

    await daemon.handleCommand('alice', noop, { owner: 111 });
    await daemon.handleCommand('bob', noop, { owner: 222 });

    assert.equal(daemon.commandHistory(111).length, 1);
    assert.equal(daemon.commandHistory(111)[0]?.userMessage, 'alice');
    assert.equal(daemon.commandHistory(222)[0]?.userMessage, 'bob');
    await daemon.stop();
  });
});

describe('health monitoring lifecycle', () => {
  function monitoringConfig(): VigylConfig {
    const base = makeConfig();
    return {
      ...base,
      monitor: { ...base.monitor, enabled: true, interval_seconds: 1, cooldown_seconds: 0 },
    };
  }

  it('starts the monitor with the daemon and clears it on stop', async () => {
    const daemon = await startedDaemon(new FakeSupervisor([]), monitoringConfig());

    assert.equal(daemon.monitorRunning, true);

    await daemon.stop();

    // The explicit requirement: no timer may outlive stop(), or the process
    // never exits.
    assert.equal(daemon.monitorRunning, false);
  });

  it('does not start the monitor when it is disabled in config', async () => {
    const daemon = await startedDaemon(new FakeSupervisor([]));

    assert.equal(daemon.monitorRunning, false);
    await daemon.stop();
  });

  it('toggles per chat and forgets subscribers on stop', async () => {
    const daemon = await startedDaemon(new FakeSupervisor([]), monitoringConfig());

    assert.equal(daemon.enableMonitoring(111), true);
    assert.equal(daemon.enableMonitoring(111), false);
    assert.equal(daemon.isMonitoring(111), true);
    assert.equal(daemon.isMonitoring(222), false, "opt-in is per chat");

    assert.equal(daemon.disableMonitoring(111), true);
    assert.equal(daemon.isMonitoring(111), false);

    await daemon.stop();
  });

  it('delivers alerts only to chats that opted in', async () => {
    const config = monitoringConfig();
    const daemon = await startedDaemon(new FakeSupervisor([]), {
      ...config,
      monitor: { ...config.monitor, cpu_percent: 1, memory_percent: 1, disk_percent: 1 },
    });

    const delivered: number[][] = [];
    daemon.onHealthAlerts((chatIds) => delivered.push([...chatIds]));
    daemon.enableMonitoring(111);

    await daemon.runHealthCheck();

    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0], [111]);
    await daemon.stop();
  });

  it('reports a snapshot without notifying anyone', async () => {
    const daemon = await startedDaemon(new FakeSupervisor([]), monitoringConfig());
    const delivered: number[][] = [];
    daemon.onHealthAlerts((chatIds) => delivered.push([...chatIds]));
    daemon.enableMonitoring(111);

    const { metrics } = await daemon.healthSnapshot();

    assert.ok(metrics.cpuPercent >= 0);
    assert.equal(delivered.length, 0);
    await daemon.stop();
  });
});
