import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { HARD_MAX_RETRIES, SelfHealingLoop, errorSignature } from './self-heal';
import type { Executor, ExecutionResult } from './executor';
import type { Supervisor, UnvalidatedPatch } from './supervisor';
import type { VigylConfig } from './config';

const NL = String.fromCharCode(10);

/** Output that classifies as build_error and points at src/app.ts. */
const BUILD_FAILURE = 'src/app.ts(1,1): error TS2304: Cannot find name foo.' + NL;
/** Output that classifies as dependency_missing. */
const MISSING_DEP = "Error: Cannot find module 'express'" + NL;

let base: string;
let workspace: string;
let outside: string;
let outsideFile: string;

class FakeExecutor extends EventEmitter {
  public readonly commands: string[] = [];
  private readonly queue: Array<{ exitCode: number; output: string }> = [];

  enqueue(exitCode: number, output: string): void {
    this.queue.push({ exitCode, output });
  }

  get isRunning(): boolean {
    return false;
  }

  async execute(command: string): Promise<ExecutionResult> {
    this.commands.push(command);
    const next = this.queue.shift() ?? { exitCode: 0, output: '' };
    this.emit('data', next.output);
    return {
      command,
      cwd: workspace,
      exitCode: next.exitCode,
      output: next.output,
      cleanOutput: next.output,
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }

  kill(): void {
    /* no-op */
  }
}

class FakeSupervisor {
  public calls = 0;
  public lastCodeContext = '';
  private readonly responses: Array<UnvalidatedPatch | undefined>;

  constructor(responses: Array<UnvalidatedPatch | undefined>) {
    this.responses = responses;
  }

  async generatePatch(
    _errorContext: string,
    codeContext: string,
  ): Promise<UnvalidatedPatch | undefined> {
    this.calls++;
    this.lastCodeContext = codeContext;
    return this.responses.shift();
  }
}

function makeConfig(overrides: Partial<VigylConfig['self_heal']> = {}): VigylConfig {
  return {
    workspace_root: workspace,
    telegram: { bot_token: '1:x', allowed_chat_ids: [1] },
    anthropic: { api_key: 'sk-ant-test', model: 'claude-haiku-4-5' },
    hitl: { require_for: ['production'], timeout_seconds: 300 },
    self_heal: { enabled: true, max_retries: 3, context_lines: 80, ...overrides },
    daemon: { log_level: 'error', log_retention_days: 7 },
  };
}

function makeLoop(
  executor: FakeExecutor,
  supervisor: FakeSupervisor,
  config: VigylConfig = makeConfig(),
): SelfHealingLoop {
  return new SelfHealingLoop(
    executor as unknown as Executor,
    supervisor as unknown as Supervisor,
    config,
  );
}

const noop = (): void => {
  /* progress messages are not under test */
};

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-heal-')));
  workspace = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), 'const broken = foo;');
  outsideFile = path.join(outside, 'authorized_keys');
  fs.writeFileSync(outsideFile, 'ORIGINAL-KEYS');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('sandbox enforcement on patch targets', () => {
  const escapes = [
    ['parent traversal', () => path.join('..', 'outside', 'authorized_keys')],
    ['absolute path outside', () => outsideFile],
    ['nested traversal', () => path.join('src', '..', '..', 'outside', 'authorized_keys')],
  ] as const;

  for (const [label, makePath] of escapes) {
    it(`rejects and does not write: ${label}`, async () => {
      const executor = new FakeExecutor();
      executor.enqueue(1, BUILD_FAILURE);
      const supervisor = new FakeSupervisor([
        {
          filePath: makePath(),
          contents: 'PWNED',
          explanation: 'Definitely the fix.',
        },
      ]);

      const result = await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

      assert.equal(result.stoppedBecause, 'patch_rejected');
      assert.equal(result.success, false);
      assert.equal(result.patches.length, 0);
      // The point of the test: the file outside the workspace is untouched.
      assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'ORIGINAL-KEYS');
      // And the loop stopped rather than burning its remaining retries.
      assert.equal(executor.commands.length, 1);
    });
  }
  it('rejects a link inside the workspace that resolves outside it', async (t) => {
    // A directory junction, not a file symlink: junctions do not need
    // elevation on Windows, so this actually runs on the dev machine. Same
    // canonicalization path either way -- the proposed path is textually
    // inside the workspace and only realpath resolution catches it.
    const linkDir = path.join(workspace, 'linked');
    try {
      fs.symlinkSync(outside, linkDir, 'junction');
    } catch {
      t.skip('link creation not permitted on this host');
      return;
    }

    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    const supervisor = new FakeSupervisor([
      { filePath: 'linked/authorized_keys', contents: 'PWNED', explanation: 'fix' },
    ]);

    const result = await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    assert.equal(result.stoppedBecause, 'patch_rejected');
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'ORIGINAL-KEYS');
  });


  it('rejects a target that does not already exist', async () => {
    // Editing a known file is a strictly smaller capability than creating
    // arbitrary new ones, and fixing a build error never requires the latter.
    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    const supervisor = new FakeSupervisor([
      { filePath: 'src/brand-new.ts', contents: 'x', explanation: 'new file' },
    ]);

    const result = await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    assert.equal(result.stoppedBecause, 'patch_rejected');
    assert.equal(fs.existsSync(path.join(workspace, 'src', 'brand-new.ts')), false);
  });

  it('will not read an error location outside the workspace into the prompt', async () => {
    const executor = new FakeExecutor();
    // The compiler reports a file outside the workspace.
    executor.enqueue(1, outsideFile + '(1,1): error TS2304: Cannot find name foo.' + NL);
    const supervisor = new FakeSupervisor([undefined]);

    await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    assert.equal(supervisor.calls, 1);
    assert.match(supervisor.lastCodeContext, /outside the workspace/);
    assert.ok(!supervisor.lastCodeContext.includes('ORIGINAL-KEYS'));
  });
});

describe('applying a valid patch', () => {
  it('writes the file, backs it up first, and re-runs the command', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    executor.enqueue(0, 'Build succeeded' + NL);
    const supervisor = new FakeSupervisor([
      { filePath: 'src/app.ts', contents: 'const fixed = 1;', explanation: 'Defined foo.' },
    ]);

    const result = await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.stoppedBecause, 'success');
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'app.ts'), 'utf-8'), 'const fixed = 1;');

    const applied = result.patches[0];
    assert.ok(applied !== undefined);
    assert.equal(fs.readFileSync(applied.backupPath, 'utf-8'), 'const broken = foo;');
  });

  it('leaves no temp file behind', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    executor.enqueue(0, 'ok');
    const supervisor = new FakeSupervisor([
      { filePath: 'src/app.ts', contents: 'fixed', explanation: 'fix' },
    ]);

    await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    const stray = fs.readdirSync(path.join(workspace, 'src')).filter((n) => n.includes('vigyl-tmp'));
    assert.deepEqual(stray, []);
  });

  it('sends the failing source to the supervisor as context', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    executor.enqueue(0, 'ok');
    const supervisor = new FakeSupervisor([
      { filePath: 'src/app.ts', contents: 'fixed', explanation: 'fix' },
    ]);

    await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    assert.match(supervisor.lastCodeContext, /const broken = foo;/);
    assert.match(supervisor.lastCodeContext, /src[\\/]app\.ts|src\/app\.ts/);
  });
});

describe('retry limits', () => {
  it('succeeds on the first run without calling the supervisor', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(0, 'all good');
    const supervisor = new FakeSupervisor([]);

    const result = await makeLoop(executor, supervisor).runWithHealing('npm test', noop);

    assert.equal(result.success, true);
    assert.equal(result.attempts, 1);
    assert.equal(supervisor.calls, 0);
  });

  it('runs at most 1 + HARD_MAX_RETRIES times', async () => {
    const executor = new FakeExecutor();
    // Always fails, and each failure is distinct so the repeat-detector does
    // not short-circuit the loop before the cap is reached.
    for (let i = 0; i < 10; i++) {
      executor.enqueue(1, `src/app.ts(${i + 1},1): error TS2304: Cannot find name f${i}.` + NL);
    }
    const supervisor = new FakeSupervisor(
      Array.from({ length: 10 }, (_unused, i) => ({
        filePath: 'src/app.ts',
        contents: `attempt ${i}`,
        explanation: 'try again',
      })),
    );

    const result = await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    assert.equal(result.success, false);
    assert.equal(result.stoppedBecause, 'retries_exhausted');
    assert.equal(result.attempts, HARD_MAX_RETRIES + 1);
    assert.equal(executor.commands.length, HARD_MAX_RETRIES + 1);
    assert.equal(result.patches.length, HARD_MAX_RETRIES);
  });

  it('clamps a config that asks for more than the hard limit', async () => {
    const executor = new FakeExecutor();
    for (let i = 0; i < 50; i++) {
      executor.enqueue(1, `src/app.ts(${i + 1},1): error TS2304: name f${i}.` + NL);
    }
    const supervisor = new FakeSupervisor(
      Array.from({ length: 50 }, () => ({
        filePath: 'src/app.ts',
        contents: 'x',
        explanation: 'try',
      })),
    );

    const result = await makeLoop(
      executor,
      supervisor,
      makeConfig({ max_retries: 99 }),
    ).runWithHealing('npm run build', noop);

    assert.equal(result.attempts, HARD_MAX_RETRIES + 1);
  });

  it('honours a config that asks for fewer retries', async () => {
    const executor = new FakeExecutor();
    for (let i = 0; i < 5; i++) {
      executor.enqueue(1, `src/app.ts(${i + 1},1): error TS2304: name f${i}.` + NL);
    }
    const supervisor = new FakeSupervisor(
      Array.from({ length: 5 }, () => ({
        filePath: 'src/app.ts',
        contents: 'x',
        explanation: 'try',
      })),
    );

    const result = await makeLoop(executor, supervisor, makeConfig({ max_retries: 1 })).runWithHealing(
      'npm run build',
      noop,
    );

    assert.equal(result.attempts, 2);
  });

  it('runs once and stops when self-healing is disabled', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    const supervisor = new FakeSupervisor([]);

    const result = await makeLoop(executor, supervisor, makeConfig({ enabled: false })).runWithHealing(
      'npm run build',
      noop,
    );

    assert.equal(result.stoppedBecause, 'disabled');
    assert.equal(executor.commands.length, 1);
    assert.equal(supervisor.calls, 0);
  });
});

describe('errorSignature', () => {
  it('ignores the timestamped log path npm appends to every failure', () => {
    // Found by running the daemon for real: without this, the same npm
    // failure looked new every time and the loop burned all three retries.
    const base = { type: 'unknown' as const, rawLines: [], exitCode: 1, signal: 'fallback' };
    const first = errorSignature({
      ...base,
      message: 'npm error A complete log can be found in: /x/_logs/2026-07-26T20_09_07_255Z-debug-0.log',
    });
    const second = errorSignature({
      ...base,
      message: 'npm error A complete log can be found in: /x/_logs/2026-07-26T20_11_44_918Z-debug-0.log',
    });

    assert.equal(first, second);
  });

  it('still tells genuinely different failures apart', () => {
    const base = { type: 'build_error' as const, rawLines: [], exitCode: 1, signal: 'compile' };
    const a = errorSignature({ ...base, message: 'src/app.ts(12,5): error TS2304: Cannot find name foo.' });
    const b = errorSignature({ ...base, message: 'src/app.ts(40,2): error TS2345: Argument of type X.' });

    assert.notEqual(a, b);
  });
});

describe('when not to attempt a patch', () => {
  it('does not ask for a patch for a missing dependency', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(1, MISSING_DEP);
    const supervisor = new FakeSupervisor([]);

    const result = await makeLoop(executor, supervisor).runWithHealing('npm start', noop);

    assert.equal(result.stoppedBecause, 'not_auto_fixable');
    assert.equal(result.errorType, 'dependency_missing');
    assert.equal(supervisor.calls, 0, 'no LLM call should be made');
    assert.equal(executor.commands.length, 1);
  });

  it('stops when the supervisor declines to offer a fix', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    const supervisor = new FakeSupervisor([undefined]);

    const result = await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    assert.equal(result.stoppedBecause, 'no_patch_offered');
    assert.equal(executor.commands.length, 1);
  });

  it('stops when the identical failure returns after a patch', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    executor.enqueue(1, BUILD_FAILURE); // patch changed nothing observable
    executor.enqueue(1, BUILD_FAILURE);
    const supervisor = new FakeSupervisor([
      { filePath: 'src/app.ts', contents: 'a', explanation: 'attempt 1' },
      { filePath: 'src/app.ts', contents: 'b', explanation: 'attempt 2' },
    ]);

    const result = await makeLoop(executor, supervisor).runWithHealing('npm run build', noop);

    assert.equal(result.stoppedBecause, 'repeated_failure');
    assert.equal(executor.commands.length, 2, 'should not keep retrying a patch that does nothing');
    assert.equal(supervisor.calls, 1);
  });

  it('survives the supervisor throwing', async () => {
    const executor = new FakeExecutor();
    executor.enqueue(1, BUILD_FAILURE);
    const supervisor = {
      calls: 0,
      lastCodeContext: '',
      generatePatch: async (): Promise<UnvalidatedPatch | undefined> => {
        throw new Error('anthropic exploded');
      },
    };

    const result = await makeLoop(executor, supervisor as unknown as FakeSupervisor).runWithHealing(
      'npm run build',
      noop,
    );

    assert.equal(result.stoppedBecause, 'no_patch_offered');
    assert.equal(result.success, false);
  });
});
