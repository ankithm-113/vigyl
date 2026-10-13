import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  isAlive,
  logFilePath,
  logFileSize,
  pidFilePath,
  readLogSince,
  readLogTail,
  readPidRecord,
  removePidFile,
  serviceState,
  terminate,
  type PidRecord,
  writePidRecord,
} from './service';

let cwd: string;
const spawned: ChildProcess[] = [];

/** A real process that stays alive until we stop it. */
function longRunningProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  spawned.push(child);
  return child;
}

function record(pid: number): PidRecord {
  return { pid, startedAt: Date.now(), workspaceRoot: cwd, version: '0.1.0' };
}

beforeEach(() => {
  cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-svc-')));
});

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('isAlive', () => {
  it('sees a live process', () => {
    const child = longRunningProcess();
    assert.ok(child.pid !== undefined);
    assert.equal(isAlive(child.pid), true);
  });

  it('does not see a process that has exited', async () => {
    const child = longRunningProcess();
    const pid = child.pid;
    assert.ok(pid !== undefined);

    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(isAlive(pid), false);
  });

  it('rejects nonsense pids instead of throwing', () => {
    assert.equal(isAlive(0), false);
    assert.equal(isAlive(-1), false);
    assert.equal(isAlive(Number.NaN), false);
  });
});

describe('pid record', () => {
  it('round-trips through disk', () => {
    writePidRecord(record(4242), cwd);
    const read = readPidRecord(cwd);

    assert.equal(read?.pid, 4242);
    assert.equal(read?.workspaceRoot, cwd);
  });

  it('treats a corrupt pid file as absent rather than crashing', () => {
    fs.mkdirSync(path.dirname(pidFilePath(cwd)), { recursive: true });
    fs.writeFileSync(pidFilePath(cwd), 'not json at all', 'utf-8');

    assert.equal(readPidRecord(cwd), undefined);
    assert.deepEqual(serviceState(cwd), { state: 'stopped' });
  });

  it('treats a pid file with no pid as absent', () => {
    fs.mkdirSync(path.dirname(pidFilePath(cwd)), { recursive: true });
    fs.writeFileSync(pidFilePath(cwd), JSON.stringify({ startedAt: 1 }), 'utf-8');

    assert.equal(readPidRecord(cwd), undefined);
  });
});

describe('serviceState', () => {
  it('reports stopped with no pid file', () => {
    assert.deepEqual(serviceState(cwd), { state: 'stopped' });
  });

  it('reports running for a live pid', () => {
    const child = longRunningProcess();
    assert.ok(child.pid !== undefined);
    writePidRecord(record(child.pid), cwd);

    const state = serviceState(cwd);
    assert.equal(state.state, 'running');
  });

  it('reports stale for a pid file left behind by a dead process', async () => {
    // The crash-and-reboot case. Reporting this as "running" is what lets
    // `vigyl start` launch a second daemon on top of the first.
    const child = longRunningProcess();
    const pid = child.pid;
    assert.ok(pid !== undefined);
    writePidRecord(record(pid), cwd);

    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const state = serviceState(cwd);
    assert.equal(state.state, 'stale');
    if (state.state !== 'stale') throw new Error('narrowing');
    assert.equal(state.record.pid, pid);
  });

  it('reports stopped again once the stale file is removed', async () => {
    const child = longRunningProcess();
    assert.ok(child.pid !== undefined);
    writePidRecord(record(child.pid), cwd);
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 400));

    removePidFile(cwd);

    assert.deepEqual(serviceState(cwd), { state: 'stopped' });
  });
});

describe('terminate', () => {
  it('stops a running process and reports success', async () => {
    const child = longRunningProcess();
    assert.ok(child.pid !== undefined);

    const stopped = await terminate(child.pid, 4_000);

    assert.equal(stopped, true);
    assert.equal(isAlive(child.pid), false);
  });

  it('returns false for a pid that is already gone', async () => {
    const child = longRunningProcess();
    const pid = child.pid;
    assert.ok(pid !== undefined);
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(await terminate(pid, 500), false);
  });
});

describe('readLogTail', () => {
  it('returns nothing when there is no log yet', () => {
    assert.deepEqual(readLogTail(10, cwd), []);
  });

  it('returns the last N non-empty lines', () => {
    const logPath = path.join(cwd, '.vigyl', 'logs', 'daemon.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const nl = String.fromCharCode(10);
    fs.writeFileSync(logPath, ['one', 'two', '', 'three', 'four', ''].join(nl), 'utf-8');

    // Reads the file directly rather than shelling out to `tail`, which the
    // build guide does and which does not exist on Windows.
    assert.deepEqual(readLogTail(2, cwd), ['three', 'four']);
  });
});

const NL = String.fromCharCode(10);

describe('log follow mode (build guide Day 11-12: streaming logs)', () => {
  function appendLog(text: string): void {
    const file = logFilePath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text, 'utf-8');
  }

  it('returns nothing when the log has not grown', () => {
    appendLog('first' + NL);
    const offset = logFileSize(cwd);

    assert.deepEqual(readLogSince(offset, cwd), { lines: [], offset });
  });

  it('returns only the lines appended since the offset', () => {
    appendLog('old' + NL);
    const offset = logFileSize(cwd);
    appendLog('new one' + NL + 'new two' + NL);

    const result = readLogSince(offset, cwd);

    assert.deepEqual(result.lines, ['new one', 'new two']);
    assert.equal(result.offset, logFileSize(cwd));
  });

  it('holds back a partial line until its newline arrives', () => {
    appendLog('done' + NL);
    const offset = logFileSize(cwd);
    appendLog('half written');

    const partial = readLogSince(offset, cwd);
    assert.deepEqual(partial.lines, []);
    assert.equal(partial.offset, offset);

    appendLog(' now complete' + NL);
    assert.deepEqual(readLogSince(partial.offset, cwd).lines, ['half written now complete']);
  });

  it('starts over when the file is rotated or truncated', () => {
    appendLog('a lot of content' + NL);
    const offset = logFileSize(cwd);
    fs.writeFileSync(logFilePath(cwd), '', 'utf-8');

    assert.deepEqual(readLogSince(offset, cwd), { lines: [], offset: 0 });
  });

  it('reports no lines and offset 0 when the log does not exist', () => {
    assert.deepEqual(readLogSince(50, path.join(cwd, 'nowhere')), { lines: [], offset: 0 });
  });
});
