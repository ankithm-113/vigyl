/**
 * The rules added in Month 2 day 4.
 *
 * Every case here is one a local 1B/1.5B model got wrong in the benchmark
 * (docs/SLM-BENCHMARK.md) at 0.8–0.9 confidence, taking 11–16 seconds. The
 * rules answer them in about a millisecond, deterministically, or they do not
 * answer at all — which is the property worth testing.
 *
 * Ordering is load-bearing throughout: an out-of-memory build prints lines that
 * look like compiler errors, a panic reads the same inside a test and outside
 * one, and a bundler that cannot read a file type looks like a syntax error.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ERROR_TYPES, classifyError, type ErrorType } from './monitor';

const NL = String.fromCharCode(10);
const lines = (...parts: string[]): string[] => parts.join(NL).split(NL);

function classify(log: string[] | string, exitCode = 1): { type: ErrorType; signal: string } {
  const asLines = Array.isArray(log) ? log : log.split(NL);
  const result = classifyError(asLines, exitCode);
  return { type: result.type, signal: result.signal };
}

describe('taxonomy', () => {
  it('carries the two classes the benchmark showed were missing', () => {
    assert.ok(ERROR_TYPES.includes('resource_exhausted'));
    assert.ok(ERROR_TYPES.includes('runtime_error'));
  });

  it('keeps unknown last, so it stays the fallback', () => {
    assert.equal(ERROR_TYPES.at(-1), 'unknown');
  });
});

describe('resource_exhausted', () => {
  const cases: Array<[string, string]> = [
    ['node heap', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    ['java heap', 'java.lang.OutOfMemoryError: Java heap space'],
    ['disk full', 'tar: write error: No space left on device'],
    ['enospc', "Error: ENOSPC: no space left on device, write '/tmp/build.log'"],
    ['enomem', 'fork failed: ENOMEM: cannot allocate memory'],
    ['oom killer', 'Container killed process 441 due to out of memory'],
    ['exit 137', 'The command exited with exit code 137'],
    ['file handles', 'Error: EMFILE: too many open files, open ./src/index.ts'],
    ['quota', 'rsync: write failed: Disk quota exceeded'],
  ];

  for (const [name, line] of cases) {
    it(`names ${name}`, () => {
      assert.equal(classify(line).type, 'resource_exhausted');
    });
  }

  it('wins over the compiler noise an OOM build prints', () => {
    // The old taxonomy had nowhere to put this, so it became build_error and
    // the self-healing loop went looking for a code fix to a machine problem.
    const log = lines(
      '> tsc -b',
      'Compiling 412 source files...',
      'error TS2307: Cannot find module',
      'FATAL ERROR: JavaScript heap out of memory',
      'Build failed',
    );
    assert.equal(classify(log).type, 'resource_exhausted');
  });
});

describe('runtime_error', () => {
  const cases: Array<[string, string]> = [
    ['unhandled rejection', 'UnhandledPromiseRejection: This error originated either by throwing inside of an async function'],
    ['unhandled rejection, prose form', '[UnhandledPromiseRejection] Unhandled promise rejection detected'],
    ['uncaught exception', 'Uncaught exception: Error: boom'],
    ['segfault', 'Segmentation fault (core dumped)'],
    ['sigsegv', 'Process terminated with SIGSEGV'],
    ['null deref', "TypeError: Cannot read properties of undefined (reading 'name')"],
    ['java npe', 'Exception in thread "main" java.lang.NullPointerException'],
  ];

  for (const [name, line] of cases) {
    it(`names ${name}`, () => {
      assert.equal(classify(line).type, 'runtime_error');
    });
  }

  it('is checked after tests, so a rejection inside a test is still a test failure', () => {
    const log = lines(
      '  ● auth › refreshes the token',
      '    UnhandledPromiseRejection: token expired',
      '    Tests: 1 failed, 8 passed',
    );
    assert.equal(classify(log).type, 'test_failure');
  });

  it('separates a panic in test code from a panic anywhere else', () => {
    const inTest = lines(
      'running 14 tests',
      "thread 'tax::tests::applies_rate' panicked at src/tax.rs:88:9:",
      'left == right',
    );
    const inProduction = lines(
      'starting worker',
      "thread 'main' panicked at src/stream.rs:12:5:",
      'index out of bounds',
    );
    assert.equal(classify(inTest).type, 'test_failure');
    assert.equal(classify(inProduction).type, 'runtime_error');
  });
});

describe('dependency_missing — a library that exists but will not load', () => {
  it('names a missing shared object, which never says "module"', () => {
    const log = lines(
      'Traceback (most recent call last):',
      '  File "/srv/app/main.py", line 3, in <module>',
      '    import numpy',
      'ImportError: libopenblas.so.0: cannot open shared object file',
    );
    assert.equal(classify(log).type, 'dependency_missing');
  });

  it('names a failed native addon load', () => {
    assert.equal(classify('Error: DLL load failed while importing _ssl').type, 'dependency_missing');
    assert.equal(
      classify('node: symbol lookup error: /app/node_modules/sharp/build/sharp.node: undefined symbol').type,
      'dependency_missing',
    );
  });
});

describe('config_error — the long tail the benchmark exposed', () => {
  it('names a required environment variable stated as a plain fatal', () => {
    const log = lines('booting api...', 'FATAL: STRIPE_SECRET must be set before the server can start');
    assert.equal(classify(log).type, 'config_error');
  });

  it('names a setting the tool does not recognise', () => {
    const log = lines(
      'Error: Unsupported argument',
      '  on main.tf line 22, in resource "aws_s3_bucket" "assets":',
      'An argument named "acl_policy" is not expected here.',
    );
    assert.equal(classify(log).type, 'config_error');
  });

  it('names a resource the configuration points at that was never created', () => {
    const log = lines(
      'sqlalchemy.exc.OperationalError: (psycopg2.OperationalError)',
      'FATAL:  database "app_production" does not exist',
    );
    assert.equal(classify(log).type, 'config_error');
  });

  it('calls a missing bundler loader configuration, not a syntax error', () => {
    // The file parses fine with the right loader, so blaming the source would
    // send a patch after code that is not wrong.
    const log = lines(
      'ERROR in ./src/styles/main.scss 1:0',
      'Module parse failed: Unexpected character "@" (1:0)',
      'You may need an appropriate loader to handle this file type.',
    );
    const result = classify(log);
    assert.equal(result.type, 'config_error');
    assert.equal(result.signal, 'loader-missing');
  });

  it('names a runtime version the project is not set up for', () => {
    const log = lines(
      'FAILURE: Build failed with an exception.',
      '   > Android Gradle plugin requires Java 17 to run. You are currently using Java 11.',
    );
    assert.equal(classify(log).type, 'config_error');
  });
});

describe('build_error — compilers that do not use familiar wording', () => {
  it('names a Rust borrow error by its code', () => {
    const log = lines(
      'error[E0502]: cannot borrow `buffer` as mutable because it is also borrowed as immutable',
      '  --> src/stream.rs:44:9',
      'error: could not compile `vigyl-core` due to previous error',
    );
    assert.equal(classify(log).type, 'build_error');
  });

  it('names a Go compile failure, which has no word "error" in it', () => {
    const log = lines(
      'go: downloading github.com/lib/pq v1.10.9',
      './handlers/user.go:27:2: declared and not used: ctx',
    );
    assert.equal(classify(log).type, 'build_error');
  });

  it('names a Java compile failure', () => {
    assert.equal(classify('src/Main.java:14: error: cannot find symbol').type, 'build_error');
  });
});

describe('test_failure — results that never say "failed"', () => {
  it('names a mocha timeout', () => {
    const log = lines(
      '  1) api integration streams events:',
      '     Error: Timeout of 5000ms exceeded. For async tests, ensure done() is called.',
    );
    assert.equal(classify(log).type, 'test_failure');
  });

  it('names a snapshot mismatch', () => {
    const log = lines(
      '    expect(received).toMatchSnapshot()',
      'Snapshots:   1 failed, 11 passed, 12 total',
    );
    assert.equal(classify(log).type, 'test_failure');
  });
});

describe('still syntax, not something newer', () => {
  it('keeps a Dockerfile parse failure as a syntax error', () => {
    const log = lines(
      '#1 [internal] load build definition from Dockerfile',
      'failed to solve: dockerfile parse error on line 14: COPY requires at least two arguments',
    );
    assert.equal(classify(log).type, 'syntax_error');
  });
});

describe('the properties that make rules worth preferring to a model', () => {
  /** One line per class, as the shortest realistic trigger. */
  const sample: Array<[ErrorType, string]> = [
    ['dependency_missing', "Error: Cannot find module 'chalk'"],
    ['permission_error', "Error: EACCES: permission denied, open '/var/log/app.log'"],
    ['network_error', 'Error: connect ECONNREFUSED 127.0.0.1:5432'],
    ['syntax_error', 'SyntaxError: Unexpected token =>'],
    ['build_error', "src/server.ts(42,18): error TS2345: Argument of type 'string'"],
    ['test_failure', 'AssertionError: expected 100 to equal 90'],
    ['config_error', 'FATAL: STRIPE_SECRET must be set before the server can start'],
    ['resource_exhausted', 'FATAL ERROR: JavaScript heap out of memory'],
    ['runtime_error', 'Segmentation fault (core dumped)'],
  ];

  it('covers every class in the taxonomy except unknown', () => {
    const covered = new Set(sample.map(([type]) => type));
    const expected = ERROR_TYPES.filter((type) => type !== 'unknown');
    assert.deepEqual([...covered].sort(), [...expected].sort());
  });

  it('is deterministic: the same output always classifies the same way', () => {
    for (const [expected, line] of sample) {
      const answers = new Set(
        Array.from({ length: 20 }, () => `${classify(line).type}/${classify(line).signal}`),
      );
      assert.equal(answers.size, 1, `${expected} classified more than one way`);
      assert.equal(classify(line).type, expected);
    }
  });

  it('is fast enough that asking a model first would be absurd', () => {
    // The benchmark measured 11–16s per answer from a local model.
    const log = Array.from({ length: 500 }, (_, i) => `line ${i} of ordinary build output`);
    log.push('FATAL ERROR: JavaScript heap out of memory');

    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) classifyError(log, 1);
    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 20;

    assert.ok(perCallMs < 50, `expected well under 50ms per call, got ${perCallMs.toFixed(1)}ms`);
  });

  it('says unknown rather than guessing, which is what makes the label trustworthy', () => {
    const vague = lines(
      'Deploying...',
      'Something went wrong. Exiting.',
      'Process finished.',
    );
    assert.equal(classify(vague).type, 'unknown');
  });

  it('does not fire on ordinary successful output', () => {
    const clean = lines(
      '> app@1.0.0 build',
      '> tsc -b',
      '',
      'Compiled 42 files in 1.4s',
      'Done.',
    );
    assert.equal(classify(clean, 0).type, 'unknown');
  });
});
