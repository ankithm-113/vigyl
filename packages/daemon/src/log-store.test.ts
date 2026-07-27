import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CommandLogStore, isValidCommandId } from './log-store';

const BS = String.fromCharCode(92);

let base: string;
let logDir: string;
let outside: string;
let store: CommandLogStore;

function meta(overrides: Record<string, unknown> = {}) {
  return { command: 'npm run build', exitCode: 0, attempts: 1, at: Date.now(), ...overrides };
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-logs-')));
  logDir = path.join(base, '.vigyl', 'logs', 'commands');
  outside = path.join(base, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SENSITIVE');
  store = new CommandLogStore(logDir);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('command id validation', () => {
  it('accepts only ids this module could have produced', () => {
    assert.equal(isValidCommandId('a1b2c3d4'), true);
    assert.equal(isValidCommandId('A1B2C3D4'), false, 'uppercase is not produced');
    assert.equal(isValidCommandId('a1b2c3d'), false, 'too short');
    assert.equal(isValidCommandId('a1b2c3d4e'), false, 'too long');
    assert.equal(isValidCommandId(''), false);
    assert.equal(isValidCommandId(undefined), false);
    assert.equal(isValidCommandId(42), false);
  });
});

describe('path sandboxing', () => {
  const attacks = [
    ['posix traversal', '../../../etc/passwd'],
    ['windows traversal', '..' + BS + '..' + BS + 'secret.txt'],
    ['absolute posix', '/etc/passwd'],
    ['nested traversal', 'a1b2c3d4/../../../secret'],
    ['NUL byte', 'a1b2c3d' + String.fromCharCode(0)],
    ['extension smuggling', 'a1b2c3d4.log.txt'],
    ['dotfile', '.env'],
    ['empty', ''],
  ] as const;

  for (const [label, id] of attacks) {
    it(`refuses to resolve: ${label}`, () => {
      assert.equal(store.resolve(id), undefined);
      assert.equal(store.read(id), undefined);
      assert.equal(store.has(id), false);
    });
  }

  it('cannot be made to read a file outside the log directory', () => {
    // The whole point: the id comes from a typed /logs argument or a forged
    // callback payload, so it must never become an arbitrary path.
    const escape = path.join('..', '..', '..', 'outside', 'secret');
    assert.equal(store.read(escape), undefined);
    // And the real file is still intact and unread.
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8'), 'SENSITIVE');
  });

  it('resolves a valid id to a path inside the log directory', () => {
    const resolved = store.resolve('a1b2c3d4');
    assert.ok(resolved !== undefined);
    assert.equal(path.dirname(resolved), path.resolve(logDir));
    assert.ok(resolved.endsWith('a1b2c3d4.log'));
  });
});

describe('write and read', () => {
  it('round-trips output through a generated id', () => {
    const id = store.write('BUILD OUTPUT LINE', meta());

    assert.ok(id !== undefined);
    assert.equal(isValidCommandId(id), true);

    const stored = store.read(id);
    assert.match(stored?.text ?? '', /BUILD OUTPUT LINE/);
  });

  it('records the command and exit code in a header', () => {
    const id = store.write('output', meta({ command: 'npm test', exitCode: 1, attempts: 2 }));
    const text = store.read(id ?? '')?.text ?? '';

    assert.match(text, /# command: npm test/);
    assert.match(text, /# exit code: 1/);
    assert.match(text, /# attempts: 2/);
  });

  it('stores nothing for empty output', () => {
    assert.equal(store.write('', meta()), undefined);
    assert.equal(store.write('   ', meta()), undefined);
  });

  it('returns undefined for an id that was never written', () => {
    assert.equal(store.read('deadbeef'), undefined);
  });

  it('caps a single enormous log', () => {
    const capped = new CommandLogStore(logDir, { maxFileBytes: 500 });
    const id = capped.write('x'.repeat(100_000), meta());

    const stored = capped.read(id ?? '');
    assert.ok((stored?.bytes ?? 0) < 1_000);
    assert.match(stored?.text ?? '', /truncated at 500 bytes/);
  });

  it('keeps the daemon running when the directory cannot be written', () => {
    // A log that cannot be saved must not take the command result down with it.
    const broken = new CommandLogStore(path.join(base, 'nope', String.fromCharCode(0), 'x'));
    assert.doesNotThrow(() => broken.write('output', meta()));
  });
});

describe('retention', () => {
  it('keeps only the newest logs by count', () => {
    const small = new CommandLogStore(logDir, { maxFiles: 3 });
    const ids: string[] = [];

    for (let i = 0; i < 6; i++) {
      const id = small.write(`output ${i}`, meta());
      if (id !== undefined) ids.push(id);
      // Distinct mtimes so "oldest" is well defined.
      const target = small.resolve(id ?? '');
      if (target !== undefined) {
        const when = new Date(Date.now() - (6 - i) * 60_000);
        fs.utimesSync(target, when, when);
      }
    }
    small.prune();

    const remaining = fs.readdirSync(logDir).filter((n) => n.endsWith('.log'));
    assert.equal(remaining.length, 3);
    // The three newest survive.
    for (const id of ids.slice(-3)) assert.ok(small.has(id), `${id} should have survived`);
  });

  it('drops old logs once the total size cap is passed', () => {
    const small = new CommandLogStore(logDir, { maxFiles: 100, maxTotalBytes: 2_000 });
    for (let i = 0; i < 8; i++) small.write('y'.repeat(800), meta());

    small.prune();

    const total = fs
      .readdirSync(logDir)
      .filter((n) => n.endsWith('.log'))
      .reduce((sum, n) => sum + fs.statSync(path.join(logDir, n)).size, 0);
    assert.ok(total <= 4_000, `total was ${total} bytes`);
  });

  it('clears everything on request', () => {
    store.write('a', meta());
    store.write('b', meta());

    assert.equal(store.clear(), 2);
    assert.equal(fs.readdirSync(logDir).filter((n) => n.endsWith('.log')).length, 0);
  });
});
