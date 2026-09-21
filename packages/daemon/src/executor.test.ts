import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  EXIT_TIMEOUT,
  Executor,
  ExecutorBusyError,
  cleanOutput,
  findExecutable,
  resolveShell,
  ptyStatus,
} from './executor';
import { SecurityError } from './security';

let root: string;
let outside: string;
let executor: Executor;

/**
 * Run node against a script file rather than `node -e "..."`. Quoting rules
 * differ across bash, cmd.exe and pwsh, and a test suite that only passes on
 * one of them defeats the point of a cross-platform shell abstraction.
 */
function script(name: string, body: string): string {
  fs.writeFileSync(path.join(root, name), body, 'utf-8');
  return `node ${name}`;
}

beforeEach(() => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-exec-')));
  root = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  executor = new Executor({ workspace_root: root });
});

afterEach(() => {
  executor.kill();
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('resolveShell', () => {
  it('finds a usable shell on this platform', () => {
    const shell = resolveShell();
    assert.ok(shell.file.length > 0);
    assert.ok(shell.toArgs('echo hi').includes('echo hi'));
  });

  it('locates executables on PATH and reports misses', () => {
    assert.ok(findExecutable('node') !== undefined);
    assert.equal(findExecutable('definitely-not-a-real-binary-xyz'), undefined);
  });
});

describe('cleanOutput', () => {
  it('strips ANSI colour codes', () => {
    const esc = String.fromCharCode(27);
    const coloured = esc + '[31mERROR' + esc + '[0m: build failed';
    assert.equal(cleanOutput(coloured), 'ERROR: build failed');
  });

  it('strips the ConPTY window-title OSC, backslashes and all', () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const bs = String.fromCharCode(92);
    const nl = String.fromCharCode(10);
    // Exactly what cmd.exe emits under ConPTY ahead of every command. The
    // stock ansi-regex leaves the drive path behind because its OSC payload
    // class contains no backslash. Built from char codes because escapes
    // written into this file get normalised into raw bytes on save.
    const title = ']0;C:' + bs + 'WINDOWS' + bs + 'system32' + bs + 'cmd.EXE';
    const raw = esc + title + bel + 'first' + nl + 'second';

    const cleaned = cleanOutput(raw);

    assert.equal(cleaned, 'first' + nl + 'second');
    assert.ok(!cleaned.includes('cmd.EXE'), 'window title must not leak into output');
  });

  it('keeps only what survives the last carriage return on a line', () => {
    // A progress bar rewriting one line should collapse to its final state,
    // not explode into one log line per frame.
    const raw = 'Building 10%\rBuilding 50%\rBuilding 100%\nDone\n';
    assert.equal(cleanOutput(raw), 'Building 100%\nDone');
  });

  it('does not eat ASCII that looks like a spinner', () => {
    const raw = 'npm run build -- --flag\n| id | name |\n|----|------|';
    const cleaned = cleanOutput(raw);
    assert.match(cleaned, /-- --flag/);
    assert.match(cleaned, /\|----\|/);
  });

  it('treats a ConPTY cursor move as a line break, not decoration', () => {
    const esc = String.fromCharCode(27);
    const nl = String.fromCharCode(10);
    // ConPTY ends a line by jumping the cursor to the next row rather than
    // emitting a newline. Deleting that as decoration welds the two lines
    // together, and monitor.ts classifies line by line.
    const raw = '  ^' + esc + '[5;1HError: Cannot find module';

    const cleaned = cleanOutput(raw);

    // Leading whitespace goes with the outer trim; the line break is the point.
    assert.equal(cleaned, '^' + nl + 'Error: Cannot find module');
  });

  it('keeps the trailing newline when trim is disabled', () => {
    const nl = String.fromCharCode(10);
    // The streaming path must not trim: the Monitor holds an unterminated
    // trailing line and would weld the next chunk onto it.
    assert.equal(cleanOutput('line one' + nl, { trim: false }), 'line one' + nl);
    assert.equal(cleanOutput('line one' + nl), 'line one');
  });

  it('collapses runs of blank lines', () => {
    assert.equal(cleanOutput('a\n\n\n\n\nb'), 'a\n\nb');
  });
});

describe('Executor.execute', () => {
  it('runs a command and captures stdout with exit code 0', async () => {
    const result = await executor.execute(
      script('hello.js', 'console.log("hello from vigyl");'),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.cleanOutput, /hello from vigyl/);
    assert.ok(result.durationMs >= 0);
  });

  it('reports a non-zero exit code rather than throwing', async () => {
    const result = await executor.execute(
      script('fail.js', 'console.log("about to fail"); process.exit(3);'),
    );

    assert.equal(result.exitCode, 3);
    assert.match(result.cleanOutput, /about to fail/);
  });

  it('runs inside the workspace root by default', async () => {
    const result = await executor.execute(script('cwd.js', 'console.log(process.cwd());'));

    assert.equal(result.cwd, root);
    assert.match(result.cleanOutput.replace(/\\/g, '/'), new RegExp(root.replace(/\\/g, '/'), 'i'));
  });

  it('kills on timeout, keeping the output produced so far', async () => {
    const result = await executor.execute(
      script('hang.js', 'console.log("started"); setInterval(() => {}, 1000);'),
      { timeoutMs: 1500 },
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, EXIT_TIMEOUT);
    assert.match(result.cleanOutput, /started/);
    assert.equal(executor.isRunning, false);
  });

  it('streams data events while the command runs', async () => {
    const chunks: string[] = [];
    executor.on('data', (chunk) => chunks.push(chunk));

    await executor.execute(script('stream.js', 'console.log("chunk-one");'));

    assert.ok(chunks.join('').includes('chunk-one'));
  });

  it('refuses to run two commands at once', async () => {
    const running = executor.execute(
      script('slow.js', 'setTimeout(() => process.exit(0), 3000);'),
      { timeoutMs: 8000 },
    );
    // Give the PTY a moment to actually be up.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await assert.rejects(() => executor.execute('node --version'), ExecutorBusyError);

    executor.kill();
    await running;
  });

  it('rejects a blocked command before spawning anything', async () => {
    await assert.rejects(() => executor.execute('sudo rm -rf /'), SecurityError);
    assert.equal(executor.isRunning, false);
  });

  it('rejects a cwd outside the workspace', async () => {
    await assert.rejects(() => executor.execute('node --version', { cwd: outside }), SecurityError);
  });


  it('propagates the exit code of a command containing quotes', async () => {
    // Regression: on Windows, passing this through argv made node-pty produce
    // a command line cmd.exe could not parse. It ran nothing and reported exit
    // 0 -- a self-healing loop would have read that as success and moved on.
    const quoted = [
      'node',
      '-e',
      String.fromCharCode(34) +
        'process.stdout.write(' +
        String.fromCharCode(39) +
        'quoted-ran' +
        String.fromCharCode(39) +
        '); process.exit(7)' +
        String.fromCharCode(34),
    ].join(' ');

    const result = await executor.execute(quoted);

    assert.equal(result.exitCode, 7);
    assert.match(result.cleanOutput, /quoted-ran/);
  });
  it('releases the busy lock after a command finishes', async () => {
    await executor.execute(script('a.js', 'console.log("a");'));
    assert.equal(executor.isRunning, false);
    const second = await executor.execute(script('b.js', 'console.log("b");'));
    assert.match(second.cleanOutput, /b/);
  });
});

describe('ptyStatus', () => {
  it('reports node-pty loadable from the daemon package', () => {
    // The dependency lives here, so this is where doctor must ask.
    assert.deepEqual(ptyStatus(), { ok: true });
  });
});
