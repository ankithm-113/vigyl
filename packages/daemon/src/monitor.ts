/**
 * Output monitor: a rolling window of recent output, plus the classifier that
 * decides what kind of failure just happened.
 *
 * This is the input to the self-healing loop (Day 6). The classification drives
 * whether Vigyl attempts an automatic fix at all, so a wrong label is not a
 * cosmetic problem: mislabelling a compile error as a config error sends the
 * Supervisor looking for the wrong thing and burns a retry.
 */
import { EventEmitter } from 'events';
import { logger } from './logger';

export const ERROR_TYPES = [
  'syntax_error',
  'dependency_missing',
  'config_error',
  'permission_error',
  'network_error',
  'build_error',
  'test_failure',
  // Added in Month 2 day 4, from the benchmark: both local models labelled
  // resource exhaustion and runtime crashes 'build_error' with high
  // confidence, and so did the rules by omission -- there was nowhere else for
  // them to go.
  'resource_exhausted',
  'runtime_error',
  'unknown',
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

export interface ErrorContext {
  type: ErrorType;
  /** The single most relevant line, ready to show a human. */
  message: string;
  /** Path as it appeared in the output — relative to the workspace, usually. */
  file?: string;
  line?: number;
  column?: number;
  /** The tail of the output the classifier looked at. */
  rawLines: string[];
  exitCode: number;
  /** Which detector fired. Logged so misclassifications can be traced. */
  signal: string;
}

const DEFAULT_MAX_BUFFER_LINES = 500;
const DEFAULT_CONTEXT_LINES = 80;
/** A minified bundle on one line would otherwise eat the whole context window. */
const MAX_LINE_LENGTH = 4_000;

interface ClassificationRule {
  type: ErrorType;
  signal: string;
  patterns: readonly RegExp[];
}

/**
 * Ordered most-specific first; the first rule with a matching line wins.
 *
 * Order is load-bearing, and it is where the build guide's version goes wrong.
 * Its config check ran third and fired on `text.includes('config')` combined
 * with the word "error" anywhere in the output — so any project with a
 * vite.config.ts or tsconfig.json in its error output got labelled
 * config_error. Config is now checked late and matches only phrasing that is
 * genuinely about configuration.
 *
 * Likewise syntax runs before build: `error TS1005` contains "error TS", but a
 * TS1xxx code is a parse failure, not a type error, and the two want different
 * fixes.
 */
const RULES: readonly ClassificationRule[] = [
  {
    // First, ahead of everything. When a machine runs out of memory or disk,
    // every other error in the output is a symptom: an OOM build prints
    // "Cannot find module" because the compiler died halfway, and labelling
    // that dependency_missing sends the self-healing loop after an npm install
    // that will not help. Resource exhaustion is the cause, so it wins.
    type: 'resource_exhausted',
    signal: 'resource',
    patterns: [
      /out of memory/i,
      /OutOfMemoryError/,
      /\bENOMEM\b/,
      /heap (?:space|limit|out of memory)/i,
      /cannot allocate memory/i,
      /no space left on device/i,
      /\bENOSPC\b/,
      /disk (?:is )?full/i,
      /quota exceeded/i,
      /too many open files/i,
      /\bEMFILE\b/,
      /killed(?: process)?.*(?:out of memory|oom)/i,
      /\bexit code 137\b/,
    ],
  },
  {
    type: 'dependency_missing',
    signal: 'module-not-found',
    patterns: [
      /cannot find module/i,
      /module not found/i,
      /no module named/i,
      /ERR_MODULE_NOT_FOUND/,
      /could not resolve (?:dependency|import)/i,
      /unable to resolve dependency tree/i,
      /is not recognized as an internal or external command/i,
      /command not found/i,
      /npm ERR! 404/i,
      /package .+ is not installed/i,
      // A shared library the installed package depends on. Python and native
      // Node addons fail this way, and the message never says "module".
      /cannot open shared object file/i,
      /error while loading shared libraries/i,
      /\bImportError\b/,
      /DLL load failed/i,
      /symbol lookup error/i,
      /\bERR_DLOPEN_FAILED\b/,
    ],
  },
  {
    type: 'permission_error',
    signal: 'permission-denied',
    patterns: [
      /permission denied/i,
      /\bEACCES\b/,
      /\bEPERM\b/,
      /access is denied/i,
      /operation not permitted/i,
      /must be run as root/i,
    ],
  },
  {
    type: 'network_error',
    signal: 'network',
    patterns: [
      /\bENOTFOUND\b/,
      /\bECONNREFUSED\b/,
      /\bECONNRESET\b/,
      /\bETIMEDOUT\b/,
      /\bEAI_AGAIN\b/,
      /getaddrinfo/i,
      /socket hang up/i,
      /network (?:error|timeout|is unreachable)/i,
      /certificate has expired/i,
      /unable to get local issuer certificate/i,
      /connect (?:etimedout|econnrefused)/i,
    ],
  },
  {
    // Gradle, npm engines, and anything else refusing to run under the
    // installed toolchain. The code is fine; the machine is set up wrong.
    // Ahead of build_error, which would otherwise claim it via "build failed".
    type: 'config_error',
    signal: 'wrong-runtime',
    patterns: [
      /requires (?:java|jdk|node|node\.js|python|ruby|go|rust) [0-9][0-9.]*/i,
      /unsupported engine/i,
      /requires? (?:a )?(?:minimum|at least) version/i,
      /you are currently using (?:java|node|python) [0-9]/i,
    ],
  },
  {
    type: 'config_error',
    signal: 'loader-missing',
    patterns: [
      /need an appropriate loader/i,
      /no loader (?:is )?configured/i,
      /unknown file extension/i,
    ],
  },
  {
    type: 'syntax_error',
    signal: 'syntax',
    patterns: [
      /SyntaxError/,
      /unexpected token/i,
      /unexpected end of (?:input|file)/i,
      /parse error/i,
      /parsing error/i,
      /unterminated string/i,
      /error TS1\d{3}\b/, // TS1xxx is the syntax/grammar range
      /IndentationError/,
      /expected .+ but found/i,
      /dockerfile parse error/i,
      /module parse failed/i,
      /invalid syntax/i,
    ],
  },
  {
    type: 'build_error',
    signal: 'compile',
    patterns: [
      /error TS(?!1\d{3}\b)\d{3,4}\b/, // every TS code except the TS1xxx syntax range
      /failed to compile/i,
      /compilation (?:failed|error)/i,
      /build failed/i,
      /type error/i,
      /\[vite\]:? .*error/i,
      /webpack.*\berror\b/i,
      /rollup failed/i,
      /error: cannot find name/i,
      // Rust: error[E0502] and the compile summary that follows it.
      /error\[E[0-9]{4}\]/,
      /could not compile/i,
      // Go: "./handlers/user.go:27:2: declared and not used: ctx"
      /declared (?:and|but) not used/i,
      /\.go:[0-9]+:[0-9]+:/,
      /undefined: [A-Za-z_]/,
      // Java/Gradle phrasing that is about the code, not configuration.
      /cannot find symbol/i,
      /incompatible types/i,
    ],
  },
  {
    type: 'test_failure',
    signal: 'tests',
    patterns: [
      /\btests? failed\b/i,
      /test suite failed/i,
      /assertion(?:error)? ?(?:failed)?/i,
      /\bAssertionError\b/,
      /^\s*●\s/,
      /^\s*✕\s/,
      /^not ok \d+/,
      /\btests?:\s*\d+ (?:failed|failing)/i,
      /\d+ (?:tests?|specs?|examples?) (?:failed|failing)\b/i,
      /\d+ (?:failed|failing)\b.*\d+ (?:passed|passing)\b/i,
      /expected .+ (?:to (?:be|equal)|received)/i,
      /timeout of [0-9]+ ?ms exceeded/i,
      /test timed out after/i,
      /toMatchSnapshot/,
      /snapshots?:.*[0-9]+ failed/i,
      // A Rust panic raised from a test module. A panic elsewhere is a runtime
      // failure, so the ::tests:: marker is load-bearing.
      /thread '[^']*::tests?::[^']*' panicked/,
      /panicked at .*tests?[\/\\]/,
    ],
  },
  {
    // After tests, so a rejection thrown inside a test is still a test failure.
    // These are patchable: an unhandled rejection is usually a real code bug.
    type: 'runtime_error',
    signal: 'runtime',
    patterns: [
      /unhandled promise rejection/i,
      /\bUnhandledPromiseRejection\b/,
      /unhandledRejection/,
      /uncaught exception/i,
      /\bUncaughtException\b/,
      /segmentation fault/i,
      /\bSIGSEGV\b/,
      /fatal error in|fatal exception/i,
      /\bTypeError\b.*(?:undefined|null)/,
      /cannot read propert(?:y|ies) .+ of (?:undefined|null)/i,
      /\bNullPointerException\b/,
      /\bpanicked at\b/,
    ],
  },
  {
    type: 'config_error',
    signal: 'configuration',
    patterns: [
      /missing (?:required )?(?:environment variable|env var)/i,
      /environment variable .+ (?:is )?(?:not set|undefined|missing|required)/i,
      /invalid configuration/i,
      /configuration error/i,
      /missing script:/i,
      /no such file or directory.*\.env/i,
      /could not (?:find|load) (?:the )?config/i,
      /\.env.*(?:not found|missing)/i,
      // "FATAL: STRIPE_SECRET must be set before the server can start"
      /\b[A-Z][A-Z0-9_]{2,} (?:must be set|is required|not configured)\b/,
      /must be set (?:before|in|for)/i,
      // Terraform, and anything else rejecting an unknown setting.
      /unsupported argument/i,
      /unsupported block type/i,
      /an argument named .+ is not expected here/i,
      /unknown (?:option|setting|field|property)/i,
      // The resource the configuration points at was never created.
      /database .+ does not exist/i,
      /role .+ does not exist/i,
      /relation .+ does not exist/i,
      /bucket .+ does not exist/i,
      // Webpack and friends: the file is fine, nothing was configured to read it.
      /need an appropriate loader/i,
      /no loader (?:is )?configured/i,
    ],
  },
];

/** Location patterns, tried in order. Every capture group is checked. */
const LOCATION_PATTERNS: readonly RegExp[] = [
  // TypeScript: src/app.ts(12,5): error TS2304: ...
  /^\s*(.+?)\((\d+),(\d+)\):\s*(?:error|warning)/,
  // Python: File "/path/to/x.py", line 12
  /File "(.+?)", line (\d+)/,
  // Node stack frame: at Foo (/path/to/file.js:12:5)
  /\bat .*?\(([^()]+?):(\d+):(\d+)\)/,
  // Bare path with line:col, including Windows drive letters
  /(?:^|[\s(])((?:[A-Za-z]:)?[^\s:()]+\.[A-Za-z]\w*):(\d+):(\d+)/,
  // Bare path with line only
  /(?:^|[\s(])((?:[A-Za-z]:)?[^\s:()]+\.[A-Za-z]\w*):(\d+)(?![\d:])/,
];

function toPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface ExtractedLocation {
  file: string;
  line?: number;
  column?: number;
}

/**
 * Pull a file/line/column out of a line of output.
 *
 * Every capture group is read through a guard rather than indexed directly.
 * The build guide's version did `fileMatch?.[1]` for the file but then
 * `parseInt(fileMatch[2])` for the line — which both loses the optional check
 * and, under noUncheckedIndexedAccess, does not compile.
 */
export function extractLocation(line: string): ExtractedLocation | undefined {
  for (const pattern of LOCATION_PATTERNS) {
    const match = pattern.exec(line);
    if (match === null) continue;

    const file = match[1];
    if (file === undefined || file.trim() === '') continue;

    const lineNumber = toPositiveInt(match[2]);
    const column = toPositiveInt(match[3]);

    return {
      file: file.trim(),
      ...(lineNumber === undefined ? {} : { line: lineNumber }),
      ...(column === undefined ? {} : { column }),
    };
  }
  return undefined;
}

/**
 * Decide what kind of failure `lines` describes.
 *
 * Pure and exported on its own so callers can classify without owning a
 * Monitor — the build guide reached for a throwaway Monitor plus a
 * once('failure') listener to get at this, which only worked because
 * EventEmitter happens to dispatch synchronously.
 */
export function classifyError(lines: readonly string[], exitCode: number): ErrorContext {
  const rawLines = [...lines];

  for (const rule of RULES) {
    for (let index = rawLines.length - 1; index >= 0; index--) {
      // Scan from the end: the actionable error is usually the last one
      // reported, not the first warning of the run.
      const line = rawLines[index];
      if (line === undefined || line.trim() === '') continue;

      const matched = rule.patterns.some((pattern) => pattern.test(line));
      if (!matched) continue;

      const location = findLocation(rawLines, index);
      return {
        type: rule.type,
        message: line.trim(),
        ...(location === undefined ? {} : location),
        rawLines,
        exitCode,
        signal: rule.signal,
      };
    }
  }

  const lastMeaningful = [...rawLines].reverse().find((line) => line.trim() !== '');
  return {
    type: 'unknown',
    message: lastMeaningful?.trim() ?? `Process exited with code ${exitCode}`,
    rawLines,
    exitCode,
    signal: 'fallback',
  };
}

/**
 * Is this a file the developer could actually edit?
 *
 * A Node stack trace is mostly internals and dependency code. Reporting
 * node:internal/modules/cjs/loader as "the file with the error" would send the
 * Day 6 patch generator after a file that does not exist on disk -- the sandbox
 * would reject the write, but only after burning a retry and an LLM call.
 * Better to report no location and let the raw lines speak.
 */
export function isLikelyUserFile(file: string): boolean {
  if (file.startsWith('node:')) return false;
  if (file.startsWith('internal/')) return false;
  if (/[\/]node_modules[\/]/.test(file)) return false;
  return true;
}
/** Look for a location on the matched line first, then nearby, then anywhere. */
function findLocation(lines: readonly string[], matchedIndex: number): ExtractedLocation | undefined {
  const matchedLine = lines[matchedIndex];
  if (matchedLine !== undefined) {
    const onMatch = extractLocation(matchedLine);
    if (onMatch !== undefined && isLikelyUserFile(onMatch.file)) return onMatch;
  }

  for (let offset = 1; offset <= 3; offset++) {
    for (const index of [matchedIndex - offset, matchedIndex + offset]) {
      if (index < 0 || index >= lines.length) continue;
      const line = lines[index];
      if (line === undefined) continue;
      const nearby = extractLocation(line);
      if (nearby !== undefined && isLikelyUserFile(nearby.file)) return nearby;
    }
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === undefined) continue;
    const anywhere = extractLocation(line);
    if (anywhere !== undefined && isLikelyUserFile(anywhere.file)) return anywhere;
  }
  return undefined;
}

export interface MonitorEvents {
  line: (line: string) => void;
  success: (payload: { exitCode: number; output: string }) => void;
  failure: (context: ErrorContext) => void;
}

export declare interface Monitor {
  on<E extends keyof MonitorEvents>(event: E, listener: MonitorEvents[E]): this;
  once<E extends keyof MonitorEvents>(event: E, listener: MonitorEvents[E]): this;
  off<E extends keyof MonitorEvents>(event: E, listener: MonitorEvents[E]): this;
  emit<E extends keyof MonitorEvents>(event: E, ...args: Parameters<MonitorEvents[E]>): boolean;
}

export class Monitor extends EventEmitter {
  private buffer: string[] = [];
  private partial = '';
  private readonly maxBufferLines: number;

  constructor(maxBufferLines: number = DEFAULT_MAX_BUFFER_LINES) {
    super();
    this.maxBufferLines = Math.max(1, maxBufferLines);
  }

  /** Lines currently retained, oldest first. */
  get lines(): readonly string[] {
    return this.buffer;
  }

  get size(): number {
    return this.buffer.length;
  }

  /**
   * Feed an arbitrary chunk of output. Chunks split mid-line all the time, so
   * an incomplete trailing line is held back until the rest arrives.
   */
  feed(chunk: string): void {
    if (chunk === '') return;

    const combined = this.partial + chunk;
    const segments = combined.split('\n');
    // The final segment has no newline yet, so it may still be incomplete.
    this.partial = segments.pop() ?? '';

    for (const segment of segments) {
      this.feedLine(segment);
    }
  }

  /** Feed exactly one complete line. */
  feedLine(line: string): void {
    const trimmed = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
    this.buffer.push(trimmed);

    if (this.buffer.length > this.maxBufferLines) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferLines);
    }
    this.emit('line', trimmed);
  }

  /** Emit any held partial line. Called automatically by onExit. */
  flush(): void {
    if (this.partial === '') return;
    const remaining = this.partial;
    this.partial = '';
    this.feedLine(remaining);
  }

  /**
   * Classify the current buffer without emitting anything or resetting.
   * This is what the self-healing loop should call.
   */
  classify(exitCode: number, contextLines: number = DEFAULT_CONTEXT_LINES): ErrorContext {
    const window = this.buffer.slice(-Math.max(1, contextLines));
    return classifyError(window, exitCode);
  }

  /**
   * Report the process exit. Emits `success` or `failure`, then clears the
   * buffer ready for the next command. Returns the context on failure so
   * callers do not have to go through the event to get it.
   */
  onExit(exitCode: number, contextLines: number = DEFAULT_CONTEXT_LINES): ErrorContext | undefined {
    this.flush();

    if (exitCode === 0) {
      this.emit('success', { exitCode, output: this.buffer.join('\n') });
      this.reset();
      return undefined;
    }

    const context = this.classify(exitCode, contextLines);
    logger.warn('Failure detected', {
      exitCode,
      type: context.type,
      signal: context.signal,
      file: context.file,
      line: context.line,
    });
    this.emit('failure', context);
    this.reset();
    return context;
  }

  reset(): void {
    this.buffer = [];
    this.partial = '';
  }
}
