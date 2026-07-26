import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Monitor, classifyError, extractLocation, type ErrorContext } from './monitor';

// Built from char codes: escape sequences written into this file get
// normalised into raw bytes on save (see the note in executor.ts).
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

function classify(lines: readonly string[], exitCode = 1): ErrorContext {
  return classifyError(lines, exitCode);
}

describe('classifyError', () => {
  it('identifies a missing dependency', () => {
    const result = classify([
      "Error: Cannot find module 'express'",
      'Require stack:',
      '- /app/server.js',
    ]);

    assert.equal(result.type, 'dependency_missing');
    assert.equal(result.signal, 'module-not-found');
  });

  it('identifies a permission failure', () => {
    const result = classify([
      "npm ERR! Error: EACCES: permission denied, open '/usr/lib/node_modules'",
    ]);

    assert.equal(result.type, 'permission_error');
  });

  it('identifies a network failure', () => {
    const result = classify([
      'npm ERR! network request to https://registry.npmjs.org/express failed,',
      'npm ERR! reason: getaddrinfo ENOTFOUND registry.npmjs.org',
    ]);

    assert.equal(result.type, 'network_error');
  });

  it('identifies a syntax error and finds the file from a nearby line', () => {
    const result = classify([
      '/app/src/index.js:3',
      'const x = ;',
      '          ^',
      '',
      'SyntaxError: Unexpected token ;',
    ]);

    assert.equal(result.type, 'syntax_error');
    assert.equal(result.file, '/app/src/index.js');
    assert.equal(result.line, 3);
  });

  it('identifies a compile error with file, line and column', () => {
    const result = classify([
      'src/app.ts(12,5): error TS2304: Cannot find name foo.',
      'Found 1 error.',
    ]);

    assert.equal(result.type, 'build_error');
    assert.equal(result.file, 'src/app.ts');
    assert.equal(result.line, 12);
    assert.equal(result.column, 5);
  });

  it('identifies a test failure', () => {
    const result = classify([
      'FAIL src/sum.test.js',
      '  ● sum adds numbers',
      '    expect(received).toBe(expected)',
      'Tests: 1 failed, 2 passed, 3 total',
    ]);

    assert.equal(result.type, 'test_failure');
  });

  it('identifies a configuration error', () => {
    const result = classify(['Error: Missing required environment variable DATABASE_URL']);

    assert.equal(result.type, 'config_error');
  });

  it('falls back to unknown, keeping the last meaningful line', () => {
    const result = classify(['starting up', 'something went sideways', '', '   ']);

    assert.equal(result.type, 'unknown');
    assert.equal(result.signal, 'fallback');
    assert.equal(result.message, 'something went sideways');
  });

  it('describes the exit code when there is no output at all', () => {
    const result = classify([], 137);

    assert.equal(result.type, 'unknown');
    assert.match(result.message, /137/);
    assert.equal(result.exitCode, 137);
  });

  it('always carries the lines it looked at', () => {
    const lines = ['one', 'two', 'SyntaxError: bad'];
    assert.deepEqual(classify(lines).rawLines, lines);
  });
});

describe('classifyError ordering', () => {
  it('does not call a compile error a config error just because a config file is named', () => {
    // The build guide checked config third, on `text.includes('config')` plus
    // the word "error" anywhere, so any project with a vite.config.ts in its
    // error output was labelled config_error and sent for the wrong fix.
    const result = classify([
      'vite.config.ts(4,3): error TS2322: Type string is not assignable to type number.',
      'Build failed with 1 error.',
    ]);

    assert.equal(result.type, 'build_error');
    assert.equal(result.file, 'vite.config.ts');
  });

  it('treats a TS1xxx code as syntax and other TS codes as a build error', () => {
    const syntax = classify(["src/app.ts(3,1): error TS1005: ')' expected."]);
    const build = classify(['src/app.ts(9,7): error TS2345: Argument of type X.']);

    assert.equal(syntax.type, 'syntax_error');
    assert.equal(build.type, 'build_error');
  });

  it('prefers a compile error over a test failure when a test run fails to build', () => {
    const result = classify([
      'FAIL src/sum.test.ts',
      '  ● Test suite failed to run',
      'src/sum.ts(4,10): error TS2554: Expected 2 arguments, but got 1.',
    ]);

    assert.equal(result.type, 'build_error');
  });

  it('reads the last error in the output, not the first warning', () => {
    const result = classify([
      'npm WARN deprecated some-package',
      'compiling...',
      "Error: Cannot find module 'lodash'",
    ]);

    assert.equal(result.type, 'dependency_missing');
    assert.match(result.message, /lodash/);
  });
});

describe('extractLocation', () => {
  it('reads the TypeScript diagnostic format', () => {
    assert.deepEqual(extractLocation('src/app.ts(12,5): error TS2304: Cannot find name foo.'), {
      file: 'src/app.ts',
      line: 12,
      column: 5,
    });
  });

  it('reads a Python traceback frame', () => {
    assert.deepEqual(extractLocation('  File "/app/main.py", line 42'), {
      file: '/app/main.py',
      line: 42,
    });
  });

  it('reads a Node stack frame', () => {
    assert.deepEqual(extractLocation('    at Object.<anonymous> (/app/server.js:10:15)'), {
      file: '/app/server.js',
      line: 10,
      column: 15,
    });
  });

  it('reads a bare path with line and column', () => {
    assert.deepEqual(extractLocation('src/foo.ts:3:1: error Unexpected console statement'), {
      file: 'src/foo.ts',
      line: 3,
      column: 1,
    });
  });

  it('reads a Windows path with a drive letter', () => {
    const winPath = 'C:' + BS + 'proj' + BS + 'src' + BS + 'app.ts';
    const location = extractLocation(winPath + ':8:3: error');

    assert.equal(location?.file, winPath);
    assert.equal(location?.line, 8);
    assert.equal(location?.column, 3);
  });

  it('returns undefined when there is no location to find', () => {
    assert.equal(extractLocation('Build failed with 1 error.'), undefined);
    assert.equal(extractLocation(''), undefined);
  });

  it('ignores a zero or negative line number rather than reporting it', () => {
    // Guarding every capture group means a malformed location degrades to
    // "no location", never to line 0 or NaN.
    const location = extractLocation('src/app.ts(0,0): error TS1000: nope');
    assert.equal(location?.file, 'src/app.ts');
    assert.equal(location?.line, undefined);
    assert.equal(location?.column, undefined);
  });
});

describe('location filtering', () => {
  it('does not report a Node internal as the file to fix', () => {
    // Every frame here is an internal; the patch generator must be told
    // nothing rather than be pointed at a file that is not on disk.
    const result = classify([
      "Error: Cannot find module 'nope'",
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1448:15)',
      '    at Module._load (node:internal/modules/cjs/loader:1075:27)',
    ]);

    assert.equal(result.type, 'dependency_missing');
    assert.equal(result.file, undefined);
  });

  it('skips node_modules frames and reports the user file', () => {
    const result = classify([
      'SyntaxError: Unexpected token',
      '    at Object.load (/app/node_modules/some-lib/index.js:5:1)',
      '    at Object.<anonymous> (/app/src/main.js:12:3)',
    ]);

    assert.equal(result.file, '/app/src/main.js');
    assert.equal(result.line, 12);
  });
});

describe('Monitor buffering', () => {
  it('holds an incomplete trailing line until the rest of it arrives', () => {
    const monitor = new Monitor();

    monitor.feed('Building');
    assert.equal(monitor.size, 0, 'a chunk with no newline is not a line yet');

    monitor.feed(' the app' + NL);
    assert.deepEqual([...monitor.lines], ['Building the app']);
  });

  it('splits a multi-line chunk into individual lines', () => {
    const monitor = new Monitor();

    monitor.feed(['one', 'two', 'three'].join(NL) + NL);

    assert.deepEqual([...monitor.lines], ['one', 'two', 'three']);
  });

  it('flushes a held partial line on demand', () => {
    const monitor = new Monitor();

    monitor.feed('no trailing newline');
    monitor.flush();

    assert.deepEqual([...monitor.lines], ['no trailing newline']);
    monitor.flush();
    assert.equal(monitor.size, 1, 'flushing twice must not duplicate the line');
  });

  it('keeps only the most recent maxBufferLines', () => {
    const monitor = new Monitor(500);

    for (let i = 0; i < 600; i++) monitor.feedLine('line ' + i);

    assert.equal(monitor.size, 500);
    assert.equal(monitor.lines[0], 'line 100');
    assert.equal(monitor.lines[499], 'line 599');
  });

  it('truncates a single absurdly long line', () => {
    const monitor = new Monitor();

    monitor.feedLine('x'.repeat(10_000));

    const stored = monitor.lines[0];
    assert.ok(stored !== undefined);
    assert.ok(stored.length < 10_000);
  });

  it('emits each completed line', () => {
    const monitor = new Monitor();
    const seen: string[] = [];
    monitor.on('line', (line) => seen.push(line));

    monitor.feed('alpha' + NL + 'beta' + NL);

    assert.deepEqual(seen, ['alpha', 'beta']);
  });
});

describe('Monitor.onExit', () => {
  it('emits success and clears the buffer on exit code 0', () => {
    const monitor = new Monitor();
    let succeeded = false;
    monitor.on('success', () => {
      succeeded = true;
    });

    monitor.feed('all good' + NL);
    const result = monitor.onExit(0);

    assert.equal(succeeded, true);
    assert.equal(result, undefined);
    assert.equal(monitor.size, 0);
  });

  it('emits failure, returns the context, and clears the buffer', () => {
    const monitor = new Monitor();
    let emitted: ErrorContext | undefined;
    monitor.on('failure', (context) => {
      emitted = context;
    });

    monitor.feed("Error: Cannot find module 'express'" + NL);
    const returned = monitor.onExit(1);

    assert.equal(returned?.type, 'dependency_missing');
    assert.equal(emitted?.type, 'dependency_missing');
    assert.equal(monitor.size, 0);
  });

  it('flushes a partial line before classifying it', () => {
    const monitor = new Monitor();

    // No trailing newline: the process died mid-line.
    monitor.feed('SyntaxError: Unexpected end of input');
    const result = monitor.onExit(1);

    assert.equal(result?.type, 'syntax_error');
  });

  it('classifies without emitting or resetting', () => {
    const monitor = new Monitor();
    let emitted = false;
    monitor.on('failure', () => {
      emitted = true;
    });

    monitor.feed('EACCES: permission denied' + NL);
    const context = monitor.classify(1);

    assert.equal(context.type, 'permission_error');
    assert.equal(emitted, false, 'classify() must not emit');
    assert.equal(monitor.size, 1, 'classify() must not reset');
  });

  it('honours the context-lines window', () => {
    const monitor = new Monitor();

    monitor.feedLine("Error: Cannot find module 'old-and-forgotten'");
    for (let i = 0; i < 50; i++) monitor.feedLine('noise ' + i);

    // The dependency error is 51 lines back, outside a 10-line window.
    assert.equal(monitor.classify(1, 10).type, 'unknown');
    assert.equal(monitor.classify(1, 100).type, 'dependency_missing');
  });
});
