import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { HistoryStore } from './history';

let dir: string;
let file: string;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    userMessage: 'build the api',
    command: 'npm run build',
    status: 'completed' as const,
    exitCode: 0,
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-hist-')));
  file = path.join(dir, '.vigyl', 'history.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistence', () => {
  it('survives a restart', () => {
    const first = new HistoryStore(file);
    first.record(111, entry({ userMessage: 'deploy to staging' }));

    // A brand new instance, as after `vigyl stop && vigyl start`.
    const second = new HistoryStore(file);

    assert.equal(second.list(111).length, 1);
    assert.equal(second.list(111)[0]?.userMessage, 'deploy to staging');
  });

  it('creates the directory if it is not there yet', () => {
    const store = new HistoryStore(file);
    store.record(111, entry());

    assert.ok(fs.existsSync(file));
  });

  it('writes valid JSON with a version stamp', () => {
    const store = new HistoryStore(file);
    store.record(111, entry());

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { version: number };
    assert.equal(parsed.version, 1);
  });

  it('leaves no temp files behind', () => {
    const store = new HistoryStore(file);
    for (let i = 0; i < 5; i++) store.record(111, entry());

    const stray = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp'));
    assert.deepEqual(stray, []);
  });

  it('starts empty when there is no file yet', () => {
    const store = new HistoryStore(file);
    assert.equal(store.chatCount, 0);
    assert.deepEqual(store.list(111), []);
  });
});

describe('corruption recovery', () => {
  it('does not throw on a truncated JSON file', () => {
    // Exactly what a non-atomic write produces when the process dies mid-flush.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "version": 1, "chats": { "111": [ {', 'utf-8');

    let store: HistoryStore | undefined;
    assert.doesNotThrow(() => {
      store = new HistoryStore(file);
    });
    assert.equal(store?.chatCount, 0);
  });

  it('moves a corrupt file aside rather than deleting it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all', 'utf-8');

    new HistoryStore(file);

    assert.ok(fs.existsSync(`${file}.corrupt`), 'the bad file should be inspectable');
    assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf-8'), 'not json at all');
  });

  it('recovers from valid JSON of the wrong shape', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[1, 2, 3]', 'utf-8');

    const store = new HistoryStore(file);
    assert.equal(store.chatCount, 0);
  });

  it('keeps well-formed entries and drops malformed ones', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chats: {
          '111': [
            { at: 1, userMessage: 'good one', status: 'completed' },
            { garbage: true },
            null,
            'a string',
          ],
        },
      }),
      'utf-8',
    );

    const store = new HistoryStore(file);

    assert.equal(store.list(111).length, 1);
    assert.equal(store.list(111)[0]?.userMessage, 'good one');
  });

  it('can still record after recovering from corruption', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{{{', 'utf-8');

    const store = new HistoryStore(file);
    store.record(111, entry({ userMessage: 'after recovery' }));

    assert.equal(new HistoryStore(file).list(111)[0]?.userMessage, 'after recovery');
  });
});

describe('chat isolation', () => {
  it('never returns one chat entries to another', () => {
    const store = new HistoryStore(file);
    store.record(111, entry({ userMessage: 'alice command' }));
    store.record(222, entry({ userMessage: 'bob command' }));

    assert.equal(store.list(111).length, 1);
    assert.equal(store.list(111)[0]?.userMessage, 'alice command');
    assert.equal(store.list(222)[0]?.userMessage, 'bob command');
  });

  it('survives a restart with chats still separate', () => {
    const first = new HistoryStore(file);
    first.record(111, entry({ userMessage: 'alice' }));
    first.record(222, entry({ userMessage: 'bob' }));

    const second = new HistoryStore(file);

    assert.equal(second.list(111).length, 1);
    assert.equal(second.list(222).length, 1);
    assert.equal(second.list(111)[0]?.userMessage, 'alice');
  });

  it('clears exactly one chat', () => {
    const store = new HistoryStore(file);
    store.record(111, entry());
    store.record(222, entry());

    assert.equal(store.clear(111), true);
    assert.equal(store.clear(111), false);

    assert.deepEqual(store.list(111), []);
    assert.equal(store.list(222).length, 1);
  });

  it('returns nothing for a chat that has run nothing', () => {
    const store = new HistoryStore(file);
    assert.deepEqual(store.list(999), []);
    assert.equal(store.lastRepeatable(999), undefined);
  });
});

describe('bounds', () => {
  it('keeps only the most recent entries per chat', () => {
    const store = new HistoryStore(file, { maxPerChat: 3 });
    for (let i = 0; i < 10; i++) store.record(111, entry({ command: `cmd-${i}` }));

    const list = store.list(111);
    assert.equal(list.length, 3);
    assert.equal(list[0]?.command, 'cmd-9', 'newest first');
    assert.equal(list[2]?.command, 'cmd-7');
  });

  it('evicts the least recently active chat past the cap', () => {
    const store = new HistoryStore(file, { maxChats: 2 });
    store.record(1, entry({ at: 1_000 }));
    store.record(2, entry({ at: 2_000 }));
    store.record(3, entry({ at: 3_000 }));

    assert.equal(store.chatCount, 2);
    assert.deepEqual(store.list(1), [], 'chat 1 was the least recent');
  });

  it('clips an enormous message rather than storing it whole', () => {
    const store = new HistoryStore(file);
    store.record(111, entry({ userMessage: 'x'.repeat(10_000) }));

    assert.ok((store.list(111)[0]?.userMessage ?? '').length < 500);
  });
});

describe('lastRepeatable', () => {
  it('returns the most recent entry that produced a command', () => {
    const store = new HistoryStore(file);
    store.record(111, entry({ userMessage: 'first', command: 'npm run one' }));
    store.record(111, entry({ userMessage: 'second', command: 'npm run two' }));

    assert.equal(store.lastRepeatable(111)?.userMessage, 'second');
  });

  it('skips entries that never became a command', () => {
    // Repeating a message that failed to parse would just fail to parse again.
    const store = new HistoryStore(file);
    store.record(111, entry({ userMessage: 'worked', command: 'npm run build' }));
    store.record(111, { userMessage: 'gibberish', status: 'error' });

    assert.equal(store.lastRepeatable(111)?.userMessage, 'worked');
  });

  it('returns the ORIGINAL user message, not the shell command', () => {
    // /repeat re-enters the supervisor pipeline with this, so the approval
    // gate re-applies; replaying the shell string would route around it.
    const store = new HistoryStore(file);
    store.record(111, entry({ userMessage: 'deploy to production', command: 'npm run deploy:prod' }));

    assert.equal(store.lastRepeatable(111)?.userMessage, 'deploy to production');
  });
});
