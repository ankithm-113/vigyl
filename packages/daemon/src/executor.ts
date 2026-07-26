/**
 * Command execution over a real PTY.
 *
 * A PTY rather than child_process.exec because build tools behave differently
 * when they think they're attached to a terminal, and because we want the same
 * bytes a human would have seen — that stream is what the Monitor (Day 4) and
 * the self-healing loop (Day 6) reason about.
 *
 * Everything here is defensive about long-running, noisy, or wedged commands:
 * output is capped, timeouts kill the process group and still return the
 * partial output, and only one command may run at a time.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type * as PtyModule from 'node-pty';
import { logger } from './logger';
import { SecurityError, SecurityLayer } from './security';
import type { VigylConfig } from './config';

/** Exit code reported for a command we killed on timeout (GNU timeout's code). */
export const EXIT_TIMEOUT = 124;

const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard cap on retained output. Beyond this we keep the head and the tail. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL on POSIX. */
const KILL_GRACE_MS = 3_000;

export interface ExecutionResult {
  command: string;
  cwd: string;
  exitCode: number;
  signal?: number;
  /** Raw bytes as the terminal produced them, escape codes included. */
  output: string;
  /** ANSI stripped, carriage returns collapsed — safe to log, parse, or send. */
  cleanOutput: string;
  durationMs: number;
  timedOut: boolean;
  /** True when output was truncated because it exceeded MAX_OUTPUT_BYTES. */
  truncated: boolean;
}

export interface ExecuteOptions {
  /** Working directory, absolute or relative to the workspace root. */
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment variables layered over the daemon's own. */
  env?: Record<string, string>;
}

export class ExecutorBusyError extends Error {
  constructor() {
    super('Executor is already running a command. Wait for it, or call kill().');
    this.name = 'ExecutorBusyError';
  }
}

export class ShellUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Cross-platform shell resolution
// ---------------------------------------------------------------------------

export interface ShellSpec {
  /** Executable to spawn. */
  file: string;
  /** Build the argv that makes this shell run `command` and exit. */
  toArgs: (command: string) => string[];
  /** Human label for logs and errors. */
  label: string;
  /**
   * Windows only. node-pty renders argv into a Windows command line using
   * MSVCRT quoting rules, which cmd.exe does not speak. A command containing
   * double quotes then silently does nothing and reports exit 0 -- the worst
   * possible failure for a self-healing daemon, which would read that as
   * success. Handing the shell a script file sidesteps argv entirely.
   */
  script?: {
    extension: string;
    render: (command: string) => string;
    toArgs: (scriptPath: string) => string[];
  };
}

function pathEntries(): string[] {
  const raw = process.env['PATH'] ?? process.env['Path'] ?? '';
  return raw.split(path.delimiter).filter((entry) => entry !== '');
}

/** Minimal `which`. Honours PATHEXT on Windows. */
export function findExecutable(name: string): string | undefined {
  if (name.includes(path.sep) || name.includes('/')) {
    return fs.existsSync(name) ? path.resolve(name) : undefined;
  }

  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')
      : [''];

  for (const dir of pathEntries()) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not there; keep looking
      }
    }
  }
  return undefined;
}

const POSIX_ARGS = (command: string): string[] => ['-c', command];
const PWSH_ARGS = (command: string): string[] => [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  command,
];
const CMD_ARGS = (command: string): string[] => ['/d', '/s', '/c', command];

const CRLF = String.fromCharCode(13, 10);

const CMD_SCRIPT = {
  extension: '.cmd',
  render: (command: string): string => ['@echo off', command, ''].join(CRLF),
  toArgs: (scriptPath: string): string[] => ['/d', '/s', '/c', scriptPath],
};

const PWSH_SCRIPT = {
  extension: '.ps1',
  // exit $LASTEXITCODE propagates a native command failure out of the script;
  // without it pwsh exits 0 even when the command inside failed.
  render: (command: string): string => [command, 'exit $LASTEXITCODE', ''].join(CRLF),
  toArgs: (scriptPath: string): string[] => [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ],
};

/**
 * Pick the shell to run commands through.
 *
 * On Windows we deliberately prefer pwsh (PowerShell 7+) and then cmd.exe, and
 * skip Windows PowerShell 5.1 — 5.1 does not support the `&&` and `||` chain
 * operators, and the Supervisor (Day 5) emits POSIX-shaped commands that use
 * them constantly. cmd.exe handles both; 5.1 would fail with a parser error on
 * something as ordinary as `npm ci && npm run build`.
 *
 * Override with VIGYL_SHELL when the default guesses wrong.
 */
export function resolveShell(): ShellSpec {
  const override = process.env['VIGYL_SHELL'];
  if (override !== undefined && override.trim() !== '') {
    const resolved = findExecutable(override.trim());
    if (resolved === undefined) {
      throw new ShellUnavailableError(
        `VIGYL_SHELL is set to "${override}", which was not found on PATH.`,
      );
    }
    const base = path.basename(resolved).toLowerCase().replace(/\.exe$/, '');
    if (base === 'cmd')
      return { file: resolved, toArgs: CMD_ARGS, label: 'cmd.exe', script: CMD_SCRIPT };
    if (base === 'pwsh' || base === 'powershell') {
      return { file: resolved, toArgs: PWSH_ARGS, label: base, script: PWSH_SCRIPT };
    }
    return { file: resolved, toArgs: POSIX_ARGS, label: base };
  }

  if (process.platform === 'win32') {
    const pwsh = findExecutable('pwsh');
    if (pwsh !== undefined)
      return { file: pwsh, toArgs: PWSH_ARGS, label: 'pwsh', script: PWSH_SCRIPT };

    const cmd = findExecutable('cmd') ?? process.env['ComSpec'];
    if (cmd !== undefined && cmd !== '') {
      return { file: cmd, toArgs: CMD_ARGS, label: 'cmd.exe', script: CMD_SCRIPT };
    }
    throw new ShellUnavailableError('No usable shell found (looked for pwsh and cmd.exe).');
  }

  for (const candidate of ['bash', 'sh']) {
    const found = findExecutable(candidate);
    if (found !== undefined) return { file: found, toArgs: POSIX_ARGS, label: candidate };
  }
  for (const fallback of ['/bin/bash', '/bin/sh']) {
    if (fs.existsSync(fallback)) {
      return { file: fallback, toArgs: POSIX_ARGS, label: path.basename(fallback) };
    }
  }
  throw new ShellUnavailableError('No usable shell found (looked for bash and sh).');
}

// ---------------------------------------------------------------------------
// Output cleaning
// ---------------------------------------------------------------------------

/**
 * CSI / OSC / single-character escape sequences (the well-known ansi-regex
 * pattern, inlined rather than taking a dependency). Written with \u escapes so
 * the source stays plain ASCII -- the first draft embedded raw ESC bytes, which
 * made git treat executor.ts as a binary file.
 */
// Control characters are built from char codes, never written as unicode
// escapes or embedded as literal bytes. An escape written into this source
// gets normalised back into a raw control byte on save, which corrupts the
// regex and makes git treat executor.ts as a binary file. Building them at
// runtime avoids the whole class of problem and keeps the source ASCII.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI_8BIT = String.fromCharCode(0x9b);
const OSC_8BIT = String.fromCharCode(0x9d);
const BACKSLASH = String.fromCharCode(0x5c);

/**
 * OSC (Operating System Command) sequences. Stripped BEFORE the CSI pass.
 *
 * ConPTY announces the window title on every single command:
 *   ESC ] 0 ; C:WINDOWSsystem32cmd.EXE BEL
 * The standard ansi-regex OSC payload class contains no backslash, so it
 * gives up partway through a Windows path and leaves the drive-and-path text
 * sitting in the output of every command. Accepting any payload up to BEL or
 * ST fixes it. Kept separate from ANSI_PATTERN, which is load-bearing for the
 * CSI cases and should not be widened.
 */
const OSC_PATTERN = new RegExp(
  '[' +
    ESC +
    OSC_8BIT +
    ']' +
    BACKSLASH +
    ']' +
    '[^' +
    BEL +
    ESC +
    ']*(?:' +
    BEL +
    '|' +
    ESC +
    BACKSLASH +
    BACKSLASH +
    ')',
  'g',
);

/** CSI / SGR / cursor-movement sequences (the ansi-regex pattern, inlined). */
const ANSI_PATTERN = new RegExp(
  '[' +
    ESC +
    CSI_8BIT +
    '][[' +
    BACKSLASH +
    ']()#;?]*' +
    '(?:(?:(?:[a-zA-Z0-9]*(?:;[-a-zA-Z0-9/#&.:=?%@~_]*)*)?' +
    BEL +
    ')|(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]))',
  'g',
);

/**
 * CSI sequences that move the cursor to a different row: CUP (H/f), CNL (E)
 * and CUD (B). These are replaced with a newline rather than deleted.
 *
 * ConPTY does not always end a line with a newline -- it emits an absolute
 * cursor move instead, e.g. "  ^" followed by ESC [ 5 ; 1 H before the next
 * line. Stripping that as decoration silently welds two lines together, and
 * the classifier in monitor.ts reasons line by line, so a merged line can
 * hide the error that actually matters.
 */
const LINE_BREAKING_ANSI = new RegExp(
  '(?:' + ESC + '[[]|' + CSI_8BIT + ')[0-9;]*[HfEB]',
  'g',
);

const NEWLINE = String.fromCharCode(10);

/** Remaining C0 controls. Tab, newline and CR are kept - they carry meaning. */
const OTHER_CONTROL_CHARS = new RegExp(
  '[' +
    Array.from({ length: 32 }, (_unused, code) => code)
      .filter((code) => code !== 9 && code !== 10 && code !== 13)
      .map((code) => String.fromCharCode(code))
      .join('') +
    String.fromCharCode(127) +
    ']',
  'g',
);

/**
 * Spinner frames. Restricted to the braille block: an earlier draft also
 * matched runs of pipe, slash, backslash and dash, which cheerfully destroyed
 * "npm run build -- --flag" and every ASCII table separator in the output.
 */
const SPINNER_CHARS = new RegExp(
  '[' + String.fromCharCode(0x2800) + '-' + String.fromCharCode(0x28ff) + ']+',
  'g',
);
const PROGRESS_BLOCKS = new RegExp(
  '[' +
    String.fromCharCode(0x2580) +
    '-' +
    String.fromCharCode(0x259f) +
    String.fromCharCode(0x25a0) +
    String.fromCharCode(0x25aa) +
    ']',
  'g',
);

/**
 * Turn raw terminal bytes into something worth logging or feeding to an LLM.
 *
 * The important part is carriage-return handling. A progress bar rewrites one
 * line hundreds of times with \r; the build guide mapped \r to \n, which turns
 * a single spinner into hundreds of near-identical log lines and floods the
 * error context window. A terminal shows only what follows the last \r, so
 * that is what we keep.
 */
export function cleanOutput(raw: string, options: { trim?: boolean } = {}): string {
  const withoutAnsi = raw
    .replace(OSC_PATTERN, '')
    .replace(LINE_BREAKING_ANSI, NEWLINE)
    .replace(ANSI_PATTERN, '');

  const lines = withoutAnsi.split(/\r?\n/).map((line) => {
    if (!line.includes('\r')) return line;
    const segments = line.split('\r');
    return segments[segments.length - 1] ?? '';
  });

  const collapsed = lines
    .join('\n')
    .replace(OTHER_CONTROL_CHARS, '')
    .replace(SPINNER_CHARS, '')
    .replace(PROGRESS_BLOCKS, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    ;

  // Streaming callers pass trim:false: trimming a chunk drops the trailing
  // newline, and the Monitor would then weld the next chunk onto this line.
  return options.trim === false ? collapsed : collapsed.trim();
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface ExecutorEvents {
  data: (chunk: string) => void;
  exit: (code: number) => void;
  error: (err: Error) => void;
}

export declare interface Executor {
  on<E extends keyof ExecutorEvents>(event: E, listener: ExecutorEvents[E]): this;
  once<E extends keyof ExecutorEvents>(event: E, listener: ExecutorEvents[E]): this;
  off<E extends keyof ExecutorEvents>(event: E, listener: ExecutorEvents[E]): this;
  emit<E extends keyof ExecutorEvents>(event: E, ...args: Parameters<ExecutorEvents[E]>): boolean;
}

let ptyModule: typeof PtyModule | undefined;

/** node-pty is an optionalDependency — fail loudly but late, not at import. */
function loadPty(): typeof PtyModule {
  if (ptyModule !== undefined) return ptyModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyModule = require('node-pty') as typeof PtyModule;
    return ptyModule;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ShellUnavailableError(
      `node-pty could not be loaded, so commands cannot be run: ${reason}\n` +
        `Reinstall dependencies, or file an issue with your platform and Node version.`,
    );
  }
}

export class Executor extends EventEmitter {
  private readonly security: SecurityLayer;
  private readonly workspaceRoot: string;
  private readonly defaultTimeoutMs: number;
  private active: PtyModule.IPty | undefined;

  constructor(config: Pick<VigylConfig, 'workspace_root'>, defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {
    super();
    this.security = new SecurityLayer(config.workspace_root);
    this.workspaceRoot = this.security.workspaceRoot;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  /**
   * Run a command and resolve once it exits.
   *
   * Rejects only for refusals (blocked command, bad cwd, no shell) and internal
   * spawn failures. A command that fails, or one we kill on timeout, resolves
   * with a result — the caller wants the exit code and the output, and the
   * self-healing loop needs the output precisely when things went wrong.
   */
  async execute(command: string, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    if (this.active !== undefined) throw new ExecutorBusyError();

    this.security.validateCommand(command);

    const cwd =
      options.cwd === undefined
        ? this.workspaceRoot
        : this.security.validatePath(options.cwd, { mustExist: true, label: 'cwd' });

    if (!fs.statSync(cwd).isDirectory()) {
      throw new SecurityError(`Access denied: cwd is not a directory: ${cwd}`, cwd);
    }

    const shell = resolveShell();
    const pty = loadPty();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = Date.now();

    // On Windows the command goes into a script file rather than argv; see the
    // note on ShellSpec.script. The directory is per-execution and mkdtemp gives
    // it 0700, so this is not a shared-tmp race.
    let scriptDir: string | undefined;
    let argv: string[];
    if (shell.script === undefined) {
      argv = shell.toArgs(command);
    } else {
      scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigyl-cmd-'));
      const scriptPath = path.join(scriptDir, 'run' + shell.script.extension);
      fs.writeFileSync(scriptPath, shell.script.render(command), 'utf-8');
      argv = shell.script.toArgs(scriptPath);
    }

    const cleanupScript = (): void => {
      if (scriptDir === undefined) return;
      try {
        fs.rmSync(scriptDir, { recursive: true, force: true });
      } catch {
        // best effort; the OS will reap tmp eventually
      }
      scriptDir = undefined;
    };

    logger.info('Executing command', { command, cwd, shell: shell.label, timeoutMs });

    return new Promise<ExecutionResult>((resolve, reject) => {
      let buffer = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      let proc: PtyModule.IPty;
      try {
        proc = pty.spawn(shell.file, argv, {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd,
          env: {
            ...(process.env as Record<string, string>),
            ...options.env,
            // We strip ANSI anyway; asking tools not to emit it keeps the raw
            // buffer readable when someone tails daemon.log directly.
            TERM: 'dumb',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          },
        });
      } catch (err) {
        cleanupScript();
        const reason = err instanceof Error ? err.message : String(err);
        reject(new ShellUnavailableError(`Failed to spawn ${shell.label}: ${reason}`));
        return;
      }

      this.active = proc;

      proc.onData((chunk: string) => {
        if (buffer.length + chunk.length > MAX_OUTPUT_BYTES) {
          if (!truncated) {
            truncated = true;
            logger.warn('Command output truncated', { command, limit: MAX_OUTPUT_BYTES });
          }
          // Keep the head, then slide a tail window — build errors live at the end.
          buffer = `${buffer.slice(0, MAX_OUTPUT_BYTES / 2)}\n…[output truncated]…\n${(
            buffer.slice(-MAX_OUTPUT_BYTES / 2) + chunk
          ).slice(-MAX_OUTPUT_BYTES / 2)}`;
        } else {
          buffer += chunk;
        }

        const cleaned = cleanOutput(chunk, { trim: false });
        if (cleaned !== '') this.emit('data', cleaned);
      });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        logger.warn('Command timed out — killing', { command, timeoutMs });
        try {
          proc.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
        } catch {
          // already gone
        }
        // If SIGTERM is ignored, escalate. Windows kills outright, so no escalation.
        if (process.platform !== 'win32') {
          killTimer = setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // already gone
            }
          }, KILL_GRACE_MS);
        }
      }, timeoutMs);

      proc.onExit(({ exitCode, signal }) => {
        if (settled) return;
        settled = true;

        clearTimeout(timeoutTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        cleanupScript();
        this.active = undefined;

        const code = timedOut ? EXIT_TIMEOUT : (exitCode ?? 0);
        const result: ExecutionResult = {
          command,
          cwd,
          exitCode: code,
          ...(signal === undefined ? {} : { signal }),
          output: buffer,
          cleanOutput: cleanOutput(buffer),
          durationMs: Date.now() - startedAt,
          timedOut,
          truncated,
        };

        logger[code === 0 ? 'info' : 'warn']('Command finished', {
          command,
          exitCode: code,
          durationMs: result.durationMs,
          timedOut,
          truncated,
        });

        this.emit('exit', code);
        resolve(result);
      });
    });
  }

  /** Kill whatever is running. No-op when idle. */
  kill(signal: string = 'SIGTERM'): void {
    const proc = this.active;
    if (proc === undefined) return;
    try {
      proc.kill(process.platform === 'win32' ? undefined : signal);
    } catch (err) {
      logger.debug('kill() failed', { reason: err instanceof Error ? err.message : String(err) });
    }
  }
}
