/**
 * Build failures with known labels, for benchmarking the local model.
 *
 * Two kinds of case, and the split is the point:
 *
 * `rules` cases are ones the daemon's regex rules already name. They are here
 * to prove the fast path stays correct, not to exercise the model — the model
 * never sees them in the real loop.
 *
 * `model` cases are ones the rules return 'unknown' for. **These are the only
 * cases that matter.** A benchmark that measured accuracy over obvious errors
 * would report a flattering number that says nothing, because in production
 * those never reach the model at all.
 *
 * Every log here is real output shape: npm, tsc, pytest, docker, cargo, go,
 * gradle and friends, including the noise before the error.
 */
export interface BenchCase {
  readonly name: string;
  readonly expect:
    | 'syntax_error'
    | 'dependency_missing'
    | 'config_error'
    | 'permission_error'
    | 'network_error'
    | 'build_error'
    | 'test_failure'
    | 'resource_exhausted'
    | 'runtime_error'
    | 'unknown';
  readonly reach: 'rules' | 'model';
  readonly log: string;
}

const NL = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NL);

export const CORPUS: readonly BenchCase[] = [
  // ── Cases the rules already answer ───────────────────────────────────────
  {
    name: 'npm missing module',
    expect: 'dependency_missing',
    reach: 'rules',
    log: lines(
      '> app@1.0.0 build',
      '> node build.js',
      '',
      'node:internal/modules/cjs/loader:1228',
      '  throw err;',
      '  ^',
      "Error: Cannot find module 'chalk'",
      'Require stack:',
      '- /srv/app/build.js',
    ),
  },
  {
    name: 'tsc type error',
    expect: 'build_error',
    reach: 'rules',
    log: lines(
      '> tsc -b',
      '',
      "src/server.ts(42,18): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      'Found 1 error.',
    ),
  },
  {
    name: 'permission denied writing a log',
    expect: 'permission_error',
    reach: 'rules',
    log: lines(
      'Starting worker...',
      "Error: EACCES: permission denied, open '/var/log/app/worker.log'",
      '    at Object.openSync (node:fs:603:3)',
    ),
  },
  {
    name: 'database connection refused',
    expect: 'network_error',
    reach: 'rules',
    log: lines(
      'Running migrations...',
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
      '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)',
    ),
  },
  {
    name: 'javascript syntax error',
    expect: 'syntax_error',
    reach: 'rules',
    log: lines(
      '/srv/app/src/routes.js:18',
      '  const handler = (req, res => {',
      '                              ^',
      '',
      'SyntaxError: Unexpected token =>',
    ),
  },

  // ── Cases the rules cannot name: the real benchmark ──────────────────────
  {
    name: 'pytest assertion',
    expect: 'test_failure',
    reach: 'rules',
    log: lines(
      '============================= test session starts ==============================',
      'platform linux -- Python 3.11.4, pytest-7.4.0',
      'collected 23 items',
      '',
      'tests/test_pricing.py .................F.....                            [100%]',
      '',
      '=================================== FAILURES ===================================',
      '____________________________ test_discount_applies _____________________________',
      '',
      '    def test_discount_applies():',
      '        cart = Cart(items=[Item(price=100)])',
      '>       assert cart.total() == 90',
      'E       assert 100 == 90',
      'E        +  where 100 = <Cart>.total()',
      '',
      'tests/test_pricing.py:31: AssertionError',
    ),
  },
  {
    // The rules call this syntax_error, which is fair: it is a parse error in
    // a Dockerfile. Labelled to match rather than argued with.
    name: 'docker build, dockerfile parse error',
    expect: 'syntax_error',
    reach: 'rules',
    log: lines(
      '#1 [internal] load build definition from Dockerfile',
      '#1 transferring dockerfile: 512B done',
      '#1 DONE 0.0s',
      '',
      'failed to solve: dockerfile parse error on line 14: COPY requires at least two arguments',
    ),
  },
  {
    name: 'go vet, unused variable',
    expect: 'build_error',
    reach: 'model',
    log: lines(
      'go: downloading github.com/lib/pq v1.10.9',
      './handlers/user.go:27:2: declared and not used: ctx',
      'make: *** [Makefile:12: build] Error 2',
    ),
  },
  {
    // Day 4 settled this: the cause is configuration (wrong JDK), and the
    // rules now have a wrong-runtime signal that says so.
    name: 'gradle, wrong java version configured',
    expect: 'config_error',
    reach: 'rules',
    log: lines(
      '> Configure project :app',
      '',
      'FAILURE: Build failed with an exception.',
      '',
      '* What went wrong:',
      'A problem occurred evaluating project :app.',
      '> Failed to apply plugin class AppPlugin.',
      '   > Android Gradle plugin requires Java 17 to run. You are currently using Java 11.',
    ),
  },
  {
    name: 'cargo, borrow checker',
    expect: 'build_error',
    reach: 'model',
    log: lines(
      '   Compiling vigyl-core v0.1.0',
      'error[E0502]: cannot borrow `buffer` as mutable because it is also borrowed as immutable',
      '  --> src/stream.rs:44:9',
      '   |',
      '42 |     let first = &buffer[0];',
      '   |                  ------ immutable borrow occurs here',
      '44 |     buffer.push(9);',
      '   |     ^^^^^^^^^^^^^ mutable borrow occurs here',
      '',
      'error: could not compile `vigyl-core` due to previous error',
    ),
  },
  {
    name: 'jest snapshot mismatch',
    expect: 'test_failure',
    reach: 'rules',
    log: lines(
      ' FAIL  src/components/Badge.test.tsx',
      '  ● Badge › renders the count',
      '',
      '    expect(received).toMatchSnapshot()',
      '',
      '    Snapshot name: `Badge renders the count 1`',
      '',
      '    - Snapshot  - 1',
      '    + Received  + 1',
      '',
      '    - <span class="badge">3</span>',
      '    + <span class="badge">4</span>',
      '',
      'Snapshots:   1 failed, 11 passed, 12 total',
    ),
  },
  {
    name: 'env var missing, phrased as a plain exit',
    expect: 'config_error',
    reach: 'model',
    log: lines(
      'booting api...',
      'FATAL: STRIPE_SECRET must be set before the server can start',
      'process exited with code 1',
    ),
  },
  {
    name: 'python import of a module that is installed but broken',
    expect: 'dependency_missing',
    reach: 'model',
    log: lines(
      'Traceback (most recent call last):',
      '  File "/srv/app/main.py", line 3, in <module>',
      '    import numpy',
      '  File "/usr/lib/python3/numpy/__init__.py", line 144, in <module>',
      '    from . import core',
      'ImportError: libopenblas.so.0: cannot open shared object file',
    ),
  },
  {
    name: 'webpack, loader not configured for a file type',
    expect: 'config_error',
    reach: 'model',
    log: lines(
      'assets by status 1.2 MiB [cached] 1 asset',
      '',
      'ERROR in ./src/styles/main.scss 1:0',
      'Module parse failed: Unexpected character "@" (1:0)',
      'You may need an appropriate loader to handle this file type.',
      '> @use "sass:math";',
    ),
  },
  {
    name: 'flaky integration test that timed out',
    expect: 'test_failure',
    reach: 'model',
    log: lines(
      '  api integration',
      '    ✓ creates a user (241ms)',
      '    1) streams events',
      '',
      '  1 passing (2s)',
      '  1 failing',
      '',
      '  1) api integration streams events:',
      '     Error: Timeout of 5000ms exceeded. For async tests, ensure done() is called.',
    ),
  },
  {
    name: 'terraform, argument that does not exist',
    expect: 'config_error',
    reach: 'model',
    log: lines(
      'Initializing provider plugins...',
      '',
      'Error: Unsupported argument',
      '',
      '  on main.tf line 22, in resource "aws_s3_bucket" "assets":',
      '  22:   acl_policy = "private"',
      '',
      'An argument named "acl_policy" is not expected here.',
    ),
  },
  {
    name: 'postgres database does not exist',
    expect: 'config_error',
    reach: 'model',
    log: lines(
      'Running alembic upgrade head...',
      'sqlalchemy.exc.OperationalError: (psycopg2.OperationalError)',
      'FATAL:  database "app_production" does not exist',
      '',
      '(Background on this error at: https://sqlalche.me/e/20/e3q8)',
    ),
  },
  {
    name: 'rust test panic',
    expect: 'test_failure',
    reach: 'model',
    log: lines(
      'running 14 tests',
      'test parser::tests::reads_header ... ok',
      "thread 'tax::tests::applies_rate' panicked at src/tax.rs:88:9:",
      'left == right',
      '  left: 110',
      ' right: 100',
      'note: run with `RUST_BACKTRACE=1` to display a backtrace',
    ),
  },
  {
    name: 'java heap exhausted',
    expect: 'resource_exhausted',
    reach: 'model',
    log: lines(
      'Compiling 412 source files...',
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3745)',
      '\tat com.sun.tools.javac.main.Main.compile(Main.java:folder)',
    ),
  },
  {
    name: 'disk full during a build',
    expect: 'resource_exhausted',
    reach: 'model',
    log: lines(
      'Copying artefacts...',
      'tar: write error: No space left on device',
      'make: *** [Makefile:30: package] Error 2',
    ),
  },
];

export const MODEL_CASES = CORPUS.filter((c) => c.reach === 'model');
export const RULE_CASES = CORPUS.filter((c) => c.reach === 'rules');
